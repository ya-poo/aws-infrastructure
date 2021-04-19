import {
    AmazonLinuxGeneration,
    AmazonLinuxImage,
    BlockDeviceVolume,
    CfnEIP,
    CfnEIPAssociation,
    CfnInternetGateway,
    CfnVPCGatewayAttachment,
    EbsDeviceVolumeType,
    Instance,
    InstanceClass,
    InstanceSize,
    InstanceType,
    Peer,
    Port,
    RouterType,
    SecurityGroup,
    Subnet,
    UserData,
    Vpc
} from '@aws-cdk/aws-ec2';
import {ManagedPolicy, Role, ServicePrincipal} from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';
import {Duration} from '@aws-cdk/core';
import {
    Credentials,
    DatabaseInstance,
    DatabaseInstanceEngine,
    DatabaseSecret,
    PostgresEngineVersion,
    StorageType
} from "@aws-cdk/aws-rds";

export class AwsInfrastructureStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        const vpc = new Vpc(this, 'Vpc', {
            cidr: '172.16.0.0/16',
            subnetConfiguration: []
        })

        const workerSubnets = [
            new Subnet(this, 'WorkerSubnet0', {
                availabilityZone: 'ap-northeast-1a',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.0.0/24',
                mapPublicIpOnLaunch: true
            }),
            new Subnet(this, 'WorkerSubnet1', {
                availabilityZone: 'ap-northeast-1c',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.1.0/24',
                mapPublicIpOnLaunch: true
            }),
            new Subnet(this, 'WorkerSubnet2', {
                availabilityZone: 'ap-northeast-1d',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.2.0/24',
                mapPublicIpOnLaunch: true
            })
        ]

        const internetGateway = new CfnInternetGateway(this, 'InternetGateway')
        new CfnVPCGatewayAttachment(this, 'VPCGatewayAttachment', {
            vpcId: vpc.vpcId,
            internetGatewayId: internetGateway.ref
        })

        workerSubnets.forEach(subnet => {
            subnet.addRoute(`${subnet.stack.stackName}PublicRoute`, {
                routerType: RouterType.GATEWAY,
                routerId: internetGateway.ref
            })
        })

        // Bastion Server
        const bastionServerSubnet = new Subnet(this, 'BastionServerSubnet', {
            availabilityZone: 'ap-northeast-1a',
            vpcId: vpc.vpcId,
            cidrBlock: '172.16.3.0/24',
            mapPublicIpOnLaunch: false
        })
        bastionServerSubnet.addRoute('BastionServerPublicRoute', {
            routerType: RouterType.GATEWAY,
            routerId: internetGateway.ref
        })
        const bastionServerSecurityGroup = new SecurityGroup(this, 'BastionServerSecurityGroup', {
            vpc: vpc,
            description: 'Security Group for Bastion Server'
        })
        const operationServerRole = new Role(this, 'BastionServerRole', {
            roleName: 'BastionServerRole',
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforSSM')
            ],
            path: '/',
            assumedBy: new ServicePrincipal('ec2.amazonaws.com')
        })
        const userData = UserData.forLinux()
        userData.addCommands(
            'set -o xtrace',
            'sudo yum install -y https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm',
            'sudo systemctl enable amazon-ssm-agent',
            'sudo systemctl start amazon-ssm-agent',
            `/opt/aws/bin/cfn-signal --exit-code $? --stack ${id} --resource NodeGroup --region ${props?.env?.region}`
        )
        const bastionServer = new Instance(this, `BastionServer`, {
            vpc: vpc,
            vpcSubnets: vpc.selectSubnets({subnets: [bastionServerSubnet]}),
            securityGroup: bastionServerSecurityGroup,
            instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
            machineImage: new AmazonLinuxImage({generation: AmazonLinuxGeneration.AMAZON_LINUX_2}),
            blockDevices: [
                {
                    deviceName: '/dev/xvda',
                    volume: BlockDeviceVolume.ebs(8, {
                        deleteOnTermination: true,
                        volumeType: EbsDeviceVolumeType.GP2
                    })
                }
            ],
            role: operationServerRole,
            userData: userData
        })
        const eip = new CfnEIP(this, 'BastionServerEIP', {
            domain: 'vpc'
        })
        new CfnEIPAssociation(this, 'BastionServerEIPAssociation', {
            allocationId: eip.attrAllocationId,
            instanceId: bastionServer.instanceId
        })

        // DB
        const rdsSubnets = [
            new Subnet(this, 'RdsSubnet1', {
                availabilityZone: 'ap-northeast-1a',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.4.0/24',
                mapPublicIpOnLaunch: false
            }),
            new Subnet(this, 'RdsSubnet2', {
                availabilityZone: 'ap-northeast-1c',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.5.0/24',
                mapPublicIpOnLaunch: false
            }),
            new Subnet(this, 'RdsSubnet3', {
                availabilityZone: 'ap-northeast-1d',
                vpcId: vpc.vpcId,
                cidrBlock: '172.16.6.0/24',
                mapPublicIpOnLaunch: false
            })
        ]
        const rdsSecurityGroup = new SecurityGroup(this, 'RdsSecurityGroup', {
            vpc: vpc,
            description: 'Security Group for RDS'
        })
        workerSubnets.forEach(subnet => {
            rdsSecurityGroup.addIngressRule(Peer.ipv4(subnet.ipv4CidrBlock), Port.tcp(5432))
        })

        const database = new DatabaseInstance(this, 'WorkDb', {
            instanceIdentifier: 'WorkDB',
            vpc: vpc,
            vpcSubnets: {subnets: rdsSubnets},
            securityGroups: [rdsSecurityGroup],
            multiAz: true,
            storageType: StorageType.GP2,
            engine: DatabaseInstanceEngine.postgres({
                version: PostgresEngineVersion.VER_12_4
            }),
            allocatedStorage: 30,
            databaseName: 'WorkDB',
            instanceType: InstanceType.of(InstanceClass.T2, InstanceSize.MICRO),
            backupRetention: Duration.days(7),
            preferredBackupWindow: '18:00-18:30',
            preferredMaintenanceWindow: 'sat:19:00-sat:19:30',
            copyTagsToSnapshot: true,
            deleteAutomatedBackups: false,
            autoMinorVersionUpgrade: false,
            deletionProtection: false,
            publiclyAccessible: false,
            credentials: Credentials.fromGeneratedSecret('workdbadmin')
        })
        database.addRotationMultiUser('WorkDbUser', {
            secret: new DatabaseSecret(this, 'WorkDbUser', {username: 'yapoo'})
        })

        // outputs
        new cdk.CfnOutput(this, 'WorkerSubnets', {
            value: workerSubnets.map(subnet => {
                return subnet.subnetId
            }).join(',')
        })
    }
}
