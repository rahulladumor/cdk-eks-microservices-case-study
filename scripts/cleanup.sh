#!/bin/bash
echo "🗑️  Destroying EKS infrastructure..."
cdk destroy --all --force
echo "✅ Cleanup complete"
