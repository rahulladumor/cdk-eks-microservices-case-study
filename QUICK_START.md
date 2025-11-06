# 🚀 Quick Start - EKS Microservices

## Prerequisites
- AWS CDK CLI
- Node.js 18+
- Docker
- kubectl

## Deploy (25-30 minutes)

```bash
# Install dependencies
npm install

# Build containers
./scripts/build-containers.sh

# Deploy
cdk deploy --all

# Configure kubectl
aws eks update-kubeconfig --name microservices-cluster
```

## Verify

```bash
# Check pods
kubectl get pods -A

# Test API
curl $(aws cloudformation describe-stacks --stack-name ApiStack --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
```

## Cleanup

```bash
cdk destroy --all
```

**Cost**: ~$400-600/month
**Services**: 5 microservices

See [README](README.md) for details.
