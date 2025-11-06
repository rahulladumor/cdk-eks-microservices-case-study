# Architecture Diagrams - Serverless Microservices on EKS

Comprehensive Mermaid diagrams for the EKS Fargate microservices architecture.

## 1. Overall Microservices Architecture

```mermaid
graph TB
    subgraph External
        Users[Users/Clients]
        Mobile[Mobile Apps]
        Web[Web Apps]
    end
    
    subgraph API Layer
        APIGW[API Gateway<br/>HTTP API<br/>JWT Authorization]
        Lambda[Lambda Authorizer<br/>Token Validation]
    end
    
    subgraph EKS Cluster - Fargate
        subgraph App Mesh Service Mesh
            subgraph API Gateway Service
                API[API Gateway Service<br/>Node.js<br/>Port 3000]
                APIEnvoy[Envoy Proxy<br/>Sidecar]
            end
            
            subgraph Auth Service
                Auth[Auth Service<br/>Go<br/>Port 8080]
                AuthEnvoy[Envoy Proxy<br/>Sidecar]
            end
            
            subgraph Users Service
                UsersSvc[Users Service<br/>Python<br/>Port 5000]
                UsersEnvoy[Envoy Proxy<br/>Sidecar]
            end
            
            subgraph Orders Service
                OrdersSvc[Orders Service<br/>Java<br/>Port 8081]
                OrdersEnvoy[Envoy Proxy<br/>Sidecar]
            end
            
            subgraph Notifications Service
                NotifSvc[Notifications Service<br/>Node.js<br/>Port 3001]
                NotifEnvoy[Envoy Proxy<br/>Sidecar]
            end
        end
    end
    
    subgraph Data Layer
        Aurora[Aurora Serverless v2<br/>PostgreSQL<br/>Auto-scaling]
        Redis[ElastiCache Redis<br/>Session Cache]
        DDB[DynamoDB<br/>Orders Table<br/>Streams Enabled]
    end
    
    subgraph Monitoring
        XRay[X-Ray<br/>Distributed Tracing]
        CW[CloudWatch<br/>Container Insights<br/>Logs & Metrics]
    end
    
    Users --> APIGW
    Mobile --> APIGW
    Web --> APIGW
    
    APIGW -->|Authenticate| Lambda
    Lambda -->|Valid| API
    
    API --> APIEnvoy
    APIEnvoy -->|Service Discovery| Auth
    APIEnvoy -->|Service Discovery| UsersSvc
    APIEnvoy -->|Service Discovery| OrdersSvc
    
    Auth --> AuthEnvoy
    UsersSvc --> UsersEnvoy
    OrdersSvc --> OrdersEnvoy
    NotifSvc --> NotifEnvoy
    
    Auth --> Aurora
    UsersSvc --> Aurora
    OrdersSvc --> DDB
    
    Auth --> Redis
    API --> Redis
    
    DDB -->|Stream| NotifSvc
    
    API --> XRay
    Auth --> XRay
    UsersSvc --> XRay
    OrdersSvc --> XRay
    NotifSvc --> XRay
    
    API --> CW
    Auth --> CW
    UsersSvc --> CW
    OrdersSvc --> CW
    NotifSvc --> CW
```

## 2. Service Mesh - AWS App Mesh

```mermaid
graph TB
    subgraph Control Plane
        AppMesh[AWS App Mesh<br/>Service Mesh Controller]
        VirtualRouter[Virtual Routers<br/>Traffic Routing]
        VirtualNode[Virtual Nodes<br/>Service Endpoints]
    end
    
    subgraph Data Plane - Envoy Proxies
        Envoy1[Envoy Sidecar<br/>API Gateway]
        Envoy2[Envoy Sidecar<br/>Auth Service]
        Envoy3[Envoy Sidecar<br/>Users Service]
        Envoy4[Envoy Sidecar<br/>Orders Service]
        Envoy5[Envoy Sidecar<br/>Notifications]
    end
    
    subgraph Features
        LB[Load Balancing<br/>Round Robin, Weighted]
        Retry[Retry Logic<br/>Exponential Backoff]
        Circuit[Circuit Breaker<br/>Failure Detection]
        TLS[mTLS<br/>Service-to-Service Encryption]
        Observe[Observability<br/>Metrics, Tracing]
    end
    
    AppMesh --> VirtualRouter
    AppMesh --> VirtualNode
    
    VirtualRouter --> Envoy1
    VirtualRouter --> Envoy2
    VirtualRouter --> Envoy3
    VirtualRouter --> Envoy4
    VirtualRouter --> Envoy5
    
    Envoy1 --> LB
    Envoy1 --> Retry
    Envoy1 --> Circuit
    Envoy1 --> TLS
    Envoy1 --> Observe
    
    Envoy2 --> LB
    Envoy3 --> LB
    Envoy4 --> LB
    Envoy5 --> LB
```

## 3. Request Flow with Service Mesh

```mermaid
sequenceDiagram
    participant Client
    participant APIGW as API Gateway
    participant Lambda as Authorizer
    participant APIEnvoy as API Envoy
    participant APISvc as API Service
    participant AuthEnvoy as Auth Envoy
    participant AuthSvc as Auth Service
    participant UsersEnvoy as Users Envoy
    participant UsersSvc as Users Service
    participant Aurora as Aurora DB
    participant XRay as X-Ray
    
    Client->>APIGW: 1. GET /api/users/123
    APIGW->>Lambda: 2. Validate JWT Token
    Lambda-->>APIGW: 3. Authorized
    
    APIGW->>APIEnvoy: 4. Forward Request
    APIEnvoy->>APISvc: 5. Route to Pod
    
    Note over APIEnvoy: Envoy intercepts,<br/>adds tracing headers
    
    APISvc->>XRay: 6. Start Trace Segment
    APISvc->>AuthEnvoy: 7. Validate User Session
    
    AuthEnvoy->>AuthEnvoy: 8. mTLS Handshake
    AuthEnvoy->>AuthSvc: 9. Forward Request
    AuthSvc->>Aurora: 10. Query Session
    Aurora-->>AuthSvc: 11. Session Valid
    AuthSvc-->>AuthEnvoy: 12. Response
    AuthEnvoy-->>APISvc: 13. Session Valid
    
    APISvc->>UsersEnvoy: 14. Get User Data
    UsersEnvoy->>UsersEnvoy: 15. Circuit Breaker Check
    UsersEnvoy->>UsersSvc: 16. Forward Request
    UsersSvc->>Aurora: 17. Query User
    Aurora-->>UsersSvc: 18. User Data
    UsersSvc-->>UsersEnvoy: 19. Response
    UsersEnvoy-->>APISvc: 20. User Data
    
    APISvc->>XRay: 21. End Trace Segment
    APISvc-->>APIEnvoy: 22. Final Response
    APIEnvoy-->>APIGW: 23. Response
    APIGW-->>Client: 24. 200 OK {user}
    
    Note over XRay: Complete trace:<br/>24ms total latency
```

## 4. EKS Fargate Pod Architecture

```mermaid
graph TB
    subgraph EKS Cluster
        subgraph Fargate Profile 1 - API Services
            subgraph Pod 1
                App1[API Gateway<br/>Container<br/>Node.js]
                Envoy1[Envoy Sidecar<br/>Container<br/>Port 15000]
                XRayAgent1[X-Ray Agent<br/>Container<br/>Daemon]
            end
            
            subgraph Pod 2
                App2[Auth Service<br/>Container<br/>Go]
                Envoy2[Envoy Sidecar<br/>Container<br/>Port 15000]
                XRayAgent2[X-Ray Agent<br/>Container<br/>Daemon]
            end
        end
        
        subgraph Fargate Profile 2 - Business Services
            subgraph Pod 3
                App3[Users Service<br/>Container<br/>Python]
                Envoy3[Envoy Sidecar<br/>Container<br/>Port 15000]
                XRayAgent3[X-Ray Agent<br/>Container<br/>Daemon]
            end
            
            subgraph Pod 4
                App4[Orders Service<br/>Container<br/>Java]
                Envoy4[Envoy Sidecar<br/>Container<br/>Port 15000]
                XRayAgent4[X-Ray Agent<br/>Container<br/>Daemon]
            end
        end
    end
    
    subgraph AWS Fargate
        vCPU[0.25 - 4 vCPU]
        Memory[0.5 - 30 GB RAM]
        Network[ENI per Pod<br/>VPC Integration]
    end
    
    subgraph No Management
        NoEC2[❌ No EC2 Instances]
        NoPatching[❌ No OS Patching]
        NoScaling[❌ No Node Scaling]
        AutoScale[✅ Auto-scaling Pods]
    end
    
    App1 --> Envoy1
    App2 --> Envoy2
    App3 --> Envoy3
    App4 --> Envoy4
    
    Pod1 --> vCPU
    Pod2 --> Memory
    Pod3 --> Network
    Pod4 --> AutoScale
```

## 5. Auto-Scaling Strategy

```mermaid
graph TB
    subgraph Metrics Sources
        CW[CloudWatch<br/>Container Insights]
        Prom[Prometheus Metrics<br/>Custom Metrics]
    end
    
    subgraph HPA - Horizontal Pod Autoscaler
        HPA[HPA Controller<br/>Kubernetes]
        CPUTarget[CPU Target: 70%]
        MemTarget[Memory Target: 80%]
        CustomTarget[Custom: Requests/sec]
    end
    
    subgraph Scaling Actions
        ScaleOut[Scale Out<br/>Add Pods<br/>Min: 2, Max: 10]
        ScaleIn[Scale In<br/>Remove Pods<br/>Cooldown: 5 min]
    end
    
    subgraph Pod Lifecycle
        Pending[Pod: Pending<br/>Fargate Provisioning]
        Running[Pod: Running<br/>Serving Traffic]
        Terminating[Pod: Terminating<br/>Graceful Shutdown]
    end
    
    CW --> HPA
    Prom --> HPA
    
    HPA --> CPUTarget
    HPA --> MemTarget
    HPA --> CustomTarget
    
    CPUTarget -->|>70%| ScaleOut
    MemTarget -->|>80%| ScaleOut
    CustomTarget -->|>100 rps| ScaleOut
    
    CPUTarget -->|<30%| ScaleIn
    MemTarget -->|<40%| ScaleIn
    
    ScaleOut --> Pending
    Pending -->|30s provision| Running
    ScaleIn --> Terminating
    Terminating -->|60s drain| Removed
```

## 6. DynamoDB Streams to Notifications

```mermaid
sequenceDiagram
    participant Orders as Orders Service
    participant DDB as DynamoDB Table
    participant Stream as DynamoDB Stream
    participant Lambda as Lambda Trigger
    participant EventBridge as EventBridge
    participant Notif as Notifications Service
    participant SNS as SNS Topic
    participant Customer as Customer
    
    Orders->>DDB: 1. Create Order (INSERT)
    DDB->>DDB: 2. Write to Table
    DDB->>Stream: 3. Stream Record (NEW_IMAGE)
    
    Stream->>Lambda: 4. Trigger Lambda
    Lambda->>EventBridge: 5. Put Event (OrderCreated)
    
    EventBridge->>Notif: 6. Route to Notification Service
    Notif->>Notif: 7. Process Order Event
    
    par Send Notifications
        Notif->>SNS: 8a. Send Email
        SNS->>Customer: 9a. Email: "Order Confirmed"
    and
        Notif->>SNS: 8b. Send SMS
        SNS->>Customer: 9b. SMS: "Order #123"
    and
        Notif->>PushService: 8c. Push Notification
        PushService->>Customer: 9c. Mobile Push
    end
    
    Notif->>DDB: 10. Log Notification Sent
```

## 7. Observability - X-Ray Tracing

```mermaid
graph LR
    subgraph Services
        API[API Gateway<br/>Segment]
        Auth[Auth Service<br/>Subsegment]
        Users[Users Service<br/>Subsegment]
        Orders[Orders Service<br/>Subsegment]
    end
    
    subgraph Data Stores
        Aurora[Aurora<br/>Subsegment]
        Redis[Redis<br/>Subsegment]
        DDB[DynamoDB<br/>Subsegment]
    end
    
    subgraph X-Ray
        Trace[Trace ID<br/>1-67891234-abcdef]
        ServiceMap[Service Map<br/>Visual Graph]
        Analytics[Analytics<br/>Latency, Errors]
    end
    
    subgraph Insights
        Bottleneck[Bottleneck Detection<br/>Slow Queries]
        Errors[Error Analysis<br/>5xx, 4xx]
        Latency[Latency Distribution<br/>P50, P99]
    end
    
    API --> Trace
    Auth --> Trace
    Users --> Trace
    Orders --> Trace
    
    Aurora --> Trace
    Redis --> Trace
    DDB --> Trace
    
    Trace --> ServiceMap
    Trace --> Analytics
    
    Analytics --> Bottleneck
    Analytics --> Errors
    Analytics --> Latency
```

## 8. Security Architecture

```mermaid
graph TB
    subgraph API Security
        JWT[JWT Tokens<br/>OAuth 2.0]
        Authorizer[Lambda Authorizer<br/>Token Validation]
        APIGW[API Gateway<br/>Rate Limiting, Throttling]
    end
    
    subgraph Network Security
        VPC[Private VPC<br/>10.0.0.0/16]
        SG[Security Groups<br/>Pod-to-Pod]
        NACL[Network ACLs<br/>Subnet Level]
        PrivateLink[VPC Endpoints<br/>No IGW Required]
    end
    
    subgraph Service-to-Service Security
        mTLS[mTLS<br/>App Mesh Encryption]
        ServiceAccount[Service Accounts<br/>IRSA - IAM Roles]
        RBAC[RBAC<br/>Kubernetes Permissions]
    end
    
    subgraph Data Security
        Encryption[Encryption at Rest<br/>KMS Keys]
        SecretsManager[Secrets Manager<br/>DB Credentials]
        SSL[SSL/TLS<br/>In-Transit Encryption]
    end
    
    JWT --> Authorizer
    Authorizer --> APIGW
    
    APIGW --> VPC
    VPC --> SG
    SG --> NACL
    VPC --> PrivateLink
    
    SG --> mTLS
    mTLS --> ServiceAccount
    ServiceAccount --> RBAC
    
    RBAC --> Encryption
    Encryption --> SecretsManager
    SecretsManager --> SSL
```

## 9. Deployment Pipeline

```mermaid
graph LR
    subgraph CI/CD
        Code[Code Commit<br/>GitHub]
        Build[Build Image<br/>Docker]
        Push[Push to ECR<br/>Container Registry]
        Deploy[Deploy to EKS<br/>kubectl apply]
    end
    
    subgraph Deployment Strategy
        Blue[Blue Environment<br/>Current Version]
        Green[Green Environment<br/>New Version]
        Canary[Canary Deployment<br/>10% Traffic]
        Full[Full Rollout<br/>100% Traffic]
    end
    
    subgraph Rollback
        Monitor[Monitor Metrics<br/>Error Rate, Latency]
        Alert[Alert on Issues<br/>CloudWatch Alarms]
        AutoRollback[Auto Rollback<br/>If Errors > 5%]
    end
    
    Code --> Build
    Build --> Push
    Push --> Deploy
    
    Deploy --> Green
    Green --> Canary
    Canary --> Monitor
    
    Monitor -->|Success| Full
    Monitor -->|Failure| AutoRollback
    
    AutoRollback --> Blue
```

## 10. Cost Optimization

```mermaid
pie title Monthly Cost Breakdown ($400-600)
    "EKS Fargate Compute" : 250
    "Aurora Serverless v2" : 150
    "ElastiCache Redis" : 50
    "DynamoDB On-Demand" : 40
    "API Gateway" : 30
    "Data Transfer" : 40
    "CloudWatch & X-Ray" : 40
```

```mermaid
graph TB
    subgraph Cost Savings Strategies
        Fargate[Fargate vs EC2<br/>No idle capacity<br/>Pay per pod]
        AuroraV2[Aurora Serverless v2<br/>Auto-scaling capacity<br/>Scale to zero]
        DDBOnDemand[DynamoDB On-Demand<br/>Pay per request<br/>No provisioning]
        RightSize[Right-size Pods<br/>CPU: 0.25-1 vCPU<br/>Memory: 0.5-2GB]
    end
    
    subgraph Monitoring
        CostExplorer[AWS Cost Explorer<br/>Track per service]
        Budgets[AWS Budgets<br/>Alert at $500]
        Tags[Resource Tags<br/>microservice=api]
    end
    
    Fargate --> CostExplorer
    AuroraV2 --> CostExplorer
    DDBOnDemand --> CostExplorer
    RightSize --> CostExplorer
    
    CostExplorer --> Budgets
    Budgets --> Tags
```

---

## Key Features

### 1. Serverless Kubernetes
- **EKS Fargate**: No EC2 management
- **Auto-scaling**: HPA based on metrics
- **5 Microservices**: Polyglot architecture

### 2. Service Mesh
- **AWS App Mesh**: Envoy sidecar proxies
- **mTLS**: Service-to-service encryption
- **Traffic Management**: Load balancing, retries, circuit breakers

### 3. Data Layer
- **Aurora Serverless v2**: Auto-scaling PostgreSQL
- **ElastiCache Redis**: Session management
- **DynamoDB**: Orders with Streams

### 4. Observability
- **X-Ray**: Distributed tracing
- **Container Insights**: Logs and metrics
- **Service Map**: Visual dependency graph

### 5. Security
- **JWT Authorization**: Lambda authorizer
- **IRSA**: IAM roles for service accounts
- **Network Isolation**: Private VPC, security groups

---

**Author**: Rahul Ladumor  
**License**: MIT 2025
