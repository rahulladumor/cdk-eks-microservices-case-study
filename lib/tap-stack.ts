import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface InfraStackProps extends cdk.StackProps {
  environmentSuffix?: string;
  // Infrastructure configuration
  lambdaRuntime?: lambda.Runtime;
  rdsEngineVersion?: rds.MysqlEngineVersion;
  rdsInstanceClass?: ec2.InstanceClass;
  rdsInstanceSize?: ec2.InstanceSize;
  codebuildImage?: codebuild.LinuxBuildImage;
  codebuildComputeType?: codebuild.ComputeType;
  backupRetentionDays?: number;
  // Monitoring configuration
  enableXRayTracing?: boolean;
  enableCloudWatchAlarms?: boolean;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: InfraStackProps) {
    super(scope, id, props);

    // Get environment suffix from context or default to empty
    const envSuffix = this.node.tryGetContext('envSuffix') || '';
    const stackName = envSuffix ? `tap-${envSuffix}` : 'tap';

    // Configuration with defaults
    const config = {
      lambdaRuntime: props?.lambdaRuntime || lambda.Runtime.NODEJS_18_X,
      rdsEngineVersion:
        props?.rdsEngineVersion || rds.MysqlEngineVersion.VER_8_0,
      rdsInstanceClass: props?.rdsInstanceClass || ec2.InstanceClass.T3,
      rdsInstanceSize: props?.rdsInstanceSize || ec2.InstanceSize.MICRO,
      codebuildImage:
        props?.codebuildImage || codebuild.LinuxBuildImage.STANDARD_5_0,
      codebuildComputeType:
        props?.codebuildComputeType || codebuild.ComputeType.SMALL,
      backupRetentionDays: props?.backupRetentionDays || 7,
      enableXRayTracing: props?.enableXRayTracing ?? true,
      enableCloudWatchAlarms: props?.enableCloudWatchAlarms ?? true,
    };

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
          origin: new origins.S3StaticWebsiteOrigin(websiteBucket),
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
      runtime: config.lambdaRuntime,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWSXRay = require('aws-xray-sdk-core');
        const AWS = AWSXRay.captureAWS(require('aws-sdk'));
        
        exports.handler = AWSXRay.captureAsyncFunc('api-handler', async (subsegment) => {
          try {
            const response = {
              statusCode: 200,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Request-ID': subsegment.trace_id,
              },
              body: JSON.stringify({
                message: 'Hello from TAP API!',
                timestamp: new Date().toISOString(),
                path: event.path,
                method: event.httpMethod,
                environment: process.env.NODE_ENV,
                version: '1.0.0',
              }),
            };
            
            subsegment.addMetadata('response', response);
            return response;
          } catch (error) {
            subsegment.addError(error);
            throw error;
          } finally {
            subsegment.close();
          }
        });
      `),
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      environment: {
        NODE_ENV: 'production',
      },
      tracing: config.enableXRayTracing
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // Add X-Ray permissions to Lambda execution role
    if (config.enableXRayTracing) {
      apiLambda.role?.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
      );
    }

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
          'X-Request-ID',
        ],
      },
      deployOptions: {
        tracingEnabled: config.enableXRayTracing,
        stageName: 'prod',
        dataTraceEnabled: config.enableXRayTracing,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
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
        version: config.rdsEngineVersion,
      }),
      instanceType: ec2.InstanceType.of(
        config.rdsInstanceClass,
        config.rdsInstanceSize
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      databaseName: 'tapdb',
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(config.backupRetentionDays),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      monitoringInterval: cdk.Duration.seconds(60),
      // Only enable Performance Insights for instance classes that support it
      enablePerformanceInsights:
        config.rdsInstanceClass !== ec2.InstanceClass.T3 ||
        config.rdsInstanceSize !== ec2.InstanceSize.MICRO,
      performanceInsightRetention:
        config.rdsInstanceClass !== ec2.InstanceClass.T3 ||
        config.rdsInstanceSize !== ec2.InstanceSize.MICRO
          ? rds.PerformanceInsightRetention.DEFAULT
          : undefined,
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
        buildImage: config.codebuildImage,
        computeType: config.codebuildComputeType,
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

    // CloudWatch Alarms for monitoring
    if (config.enableCloudWatchAlarms) {
      // Lambda Error Rate Alarm
      new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
        metric: apiLambda.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 2,
        alarmDescription: 'Lambda function error rate is high',
        alarmName: `${stackName}-lambda-errors`,
      });

      // Lambda Duration Alarm
      new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
        metric: apiLambda.metricDuration({
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 10000, // 10 seconds
        evaluationPeriods: 2,
        alarmDescription: 'Lambda function duration is high',
        alarmName: `${stackName}-lambda-duration`,
      });

      // API Gateway 4XX Error Rate Alarm
      new cloudwatch.Alarm(this, 'Api4xxAlarm', {
        metric: api.metricClientError({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 10,
        evaluationPeriods: 2,
        alarmDescription: 'API Gateway 4XX error rate is high',
        alarmName: `${stackName}-api-4xx-errors`,
      });

      // API Gateway 5XX Error Rate Alarm
      new cloudwatch.Alarm(this, 'Api5xxAlarm', {
        metric: api.metricServerError({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 5,
        evaluationPeriods: 2,
        alarmDescription: 'API Gateway 5XX error rate is high',
        alarmName: `${stackName}-api-5xx-errors`,
      });

      // Database CPU Utilization Alarm
      new cloudwatch.Alarm(this, 'DatabaseCpuAlarm', {
        metric: database.metricCPUUtilization({
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 80,
        evaluationPeriods: 2,
        alarmDescription: 'Database CPU utilization is high',
        alarmName: `${stackName}-db-cpu-utilization`,
      });

      // Database Connection Count Alarm
      new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
        metric: database.metricDatabaseConnections({
          period: cdk.Duration.minutes(5),
          statistic: 'Average',
        }),
        threshold: 80,
        evaluationPeriods: 2,
        alarmDescription: 'Database connection count is high',
        alarmName: `${stackName}-db-connections`,
      });
    }
  }
}
