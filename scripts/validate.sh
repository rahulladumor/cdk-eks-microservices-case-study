#!/bin/bash
echo "🔍 Validating CDK code..."
npm run build
cdk synth
echo "✅ Validation complete"
