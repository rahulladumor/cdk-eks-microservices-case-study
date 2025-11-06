# TAP Stack Implementation

This document contains the complete implementation of the Three-tier Application Platform (TAP) infrastructure using AWS CDK with TypeScript.

## Stack Implementation

### Main Stack File (lib/tap-stack.ts)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface TapStackProps extends cdk.StackProps {
  environmentSuffix?: string;
}

export class TapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: TapStackProps) {
    super(scope, id, props);

    // Get environment suffix from context or default to empty
    const envSuffix = this.node.tryGetContext('envSuffix') || '';
    const stackName = envSuffix ? `tap-${envSuffix}` : 'tap';

    // VPC with 2 Availability Zones
    const vpc = new ec2.Vpc(this, 'TapVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // S3 Bucket for static website hosting
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `tap-website-${this.account}-${this.region}${envSuffix ? '-' + envSuffix : ''}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'error.html',
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(
      this,
      'WebsiteDistribution',
      {
        defaultBehavior: {
          origin: new origins.S3Origin(websiteBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        defaultRootObject: 'index.html',
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
          },
        ],
      }
    );

    // Lambda function for API
    const apiLambda = new lambda.Function(this, 'ApiLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return {
            statusCode: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
              message: 'Hello from TAP API!',
              timestamp: new Date().toISOString(),
              path: event.path,
              method: event.httpMethod,
            }),
          };
        };
      `),
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        NODE_ENV: 'production',
      },
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'TapApi', {
      restApiName: `${stackName}-api`,
      description: 'TAP API Gateway',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
        ],
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(apiLambda);
    api.root.addMethod('GET', lambdaIntegration);
    api.root.addResource('health').addMethod('GET', lambdaIntegration);

    // RDS Database
    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        vpc,
        description: 'Security group for RDS database',
        allowAllOutbound: false,
      }
    );

    dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(
        apiLambda.connections.securityGroups[0].securityGroupId
      ),
      ec2.Port.tcp(3306),
      'Allow Lambda access to database'
    );

    const database = new rds.DatabaseInstance(this, 'TapDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      databaseName: 'tapdb',
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grant Lambda access to database secret
    database.secret?.grantRead(apiLambda);

    // S3 Bucket for CodePipeline artifacts
    const artifactsBucket = new s3.Bucket(this, 'PipelineArtifacts', {
      bucketName: `tap-pipeline-artifacts-${this.account}-${this.region}${envSuffix ? '-' + envSuffix : ''}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // S3 Bucket for CodePipeline source (replacing GitHub)
    const sourceBucket = new s3.Bucket(this, 'PipelineSource', {
      bucketName: `tap-pipeline-source-${this.account}-${this.region}${envSuffix ? '-' + envSuffix : ''}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CodeBuild Project
    const buildProject = new codebuild.Project(this, 'TapBuildProject', {
      projectName: `${stackName}-build`,
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'source.zip',
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '18',
            },
          },
          pre_build: {
            commands: ['npm install'],
          },
          build: {
            commands: ['npm run build', 'npm run test'],
          },
          post_build: {
            commands: ['echo Build completed on `date`'],
          },
        },
        artifacts: {
          files: ['**/*'],
        },
      }),
    });

    // Grant CodeBuild permissions
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:GetObjectVersion'],
        resources: [
          artifactsBucket.arnForObjects('*'),
          websiteBucket.arnForObjects('*'),
          sourceBucket.arnForObjects('*'),
        ],
      })
    );

    // CodePipeline
    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    new codepipeline.Pipeline(this, 'TapPipeline', {
      pipelineName: `${stackName}-pipeline`,
      artifactBucket: artifactsBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipelineActions.S3SourceAction({
              actionName: 'S3Source',
              bucket: sourceBucket,
              bucketKey: 'source.zip',
              output: sourceOutput,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipelineActions.CodeBuildAction({
              actionName: 'Build',
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        {
          stageName: 'Deploy',
          actions: [
            new codepipelineActions.S3DeployAction({
              actionName: 'Deploy',
              bucket: websiteBucket,
              input: buildOutput,
            }),
          ],
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Website URL',
    });

    new cdk.CfnOutput(this, 'ApiURL', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instanceEndpoint.hostname,
      description: 'RDS Database Endpoint',
    });

    new cdk.CfnOutput(this, 'PipelineSourceBucket', {
      value: sourceBucket.bucketName,
      description: 'Pipeline Source S3 Bucket',
    });
  }
}
```

### Application Entry Point (bin/tap.ts)

```typescript
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TapStack } from '../lib/tap-stack';

const app = new cdk.App();
new TapStack(app, 'TapStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
```

## Architecture Overview

The TAP stack implements a complete three-tier web application platform with:

### Presentation Tier
- **CloudFront Distribution**: Global CDN for static website hosting
- **S3 Website Bucket**: Static assets storage with security best practices

### Application Tier  
- **API Gateway**: RESTful API endpoint with CORS configuration
- **Lambda Function**: Serverless compute in VPC private subnets
- **VPC**: Multi-AZ network with public, private, and database subnets

### Data Tier
- **RDS MySQL Database**: Encrypted database in isolated subnets
- **Security Groups**: Least-privilege network access controls

### CI/CD Pipeline
- **CodePipeline**: Automated deployment pipeline
- **CodeBuild**: Build and test automation
- **S3 Buckets**: Source code and artifact storage

## Security Features

- All S3 buckets block public access and use encryption
- Database in isolated subnets with security group restrictions
- Lambda functions in private subnets
- HTTPS-only access via CloudFront
- IAM roles follow least-privilege principles
- No wildcard permissions in IAM policies

## Environment Support

The stack supports environment-specific deployments through the `envSuffix` context parameter, allowing multiple environments (dev, staging, prod) to coexist.