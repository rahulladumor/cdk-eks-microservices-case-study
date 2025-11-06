#!/bin/bash
set -e

echo "🐳 Deploying EKS Microservices"
echo "==============================="

# Check prerequisites
if ! command -v cdk &> /dev/null; then
    echo "❌ CDK CLI not found"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build containers
echo "🐳 Building containers..."
./scripts/build-containers.sh

# Deploy
echo "🚀 Deploying CDK stacks..."
cdk deploy --all --require-approval never

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Configure kubectl:"
echo "  aws eks update-kubeconfig --name microservices-cluster"
