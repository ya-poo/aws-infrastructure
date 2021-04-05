#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';

import { AwsInfrastructureStack } from '../lib/AwsInfrastructureStack';

const app = new cdk.App();
new AwsInfrastructureStack(app, 'SandboxAwsInfrastructureStack', {
    description: 'AWS Sandbox Created by yapoo.',
    env: {
        region: 'ap-northeast-1'
    }
})
app.synth()
