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
    RouterType,
    SecurityGroup,
    Subnet,
    UserData,
    Vpc
} from '@aws-cdk/aws-ec2';
import {ManagedPolicy, Role, ServicePrincipal} from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';

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
        const operationServerRole = new Role(this, `BastionServerRole`, {
            roleName: `BastionServerRole`,
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

        new cdk.CfnOutput(this, `WorkerSubnets`, {
            value: workerSubnets.map(subnet => {
                return subnet.subnetId
            }).join(',')
        })
    }
}
