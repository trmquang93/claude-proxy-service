# Claude Proxy Service

A simple API proxy service that allows teams to access Claude Pro/Max through centralized API keys.

## Features

- User authentication (register/login)
- Claude Pro/Max OAuth integration
- API key generation and management
- Request proxying to Claude API with automatic token refresh
- Simple web dashboard

## Setup

### Prerequisites

- [Bun](https://bun.sh/) installed
- Claude Pro/Max account

### Installation

1. Navigate to project directory:
```bash
cd claude-proxy-service
```

2. Install dependencies (already done):
```bash
bun install
```

3. Configure environment variables in `.env`:
```
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
PORT=3000
CLAUDE_CLIENT_ID=9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

4. Start the server:
```bash
bun run dev
```

The server will start at `http://localhost:3000`

## Usage

### 1. Register & Login

1. Open `http://localhost:3000` in your browser
2. Register a new account or login with existing credentials

### 2. Connect Claude Account

1. After logging in, you'll be redirected to the dashboard
2. Click "Connect Claude Account"
3. A new window will open with Claude's OAuth authorization page
4. Authorize the application
5. Copy the authorization code from the callback URL
6. Paste it in the prompt

### 3. Generate API Key

1. Once connected, click "Generate New API Key"
2. **Save the key immediately** - it will only be shown once
3. Use this key for team members to access Claude API

### 4. Use the Proxy

Team members can now use the proxy endpoint with the generated API key:

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user

### Claude OAuth
- `GET /api/claude/connect` - Get OAuth authorization URL
- `POST /api/claude/callback` - Exchange authorization code for tokens
- `GET /api/claude/status` - Check OAuth connection status
- `DELETE /api/claude/disconnect` - Disconnect Claude account

### API Keys
- `POST /api/keys/generate` - Generate new API key
- `GET /api/keys/list` - List user's API keys
- `DELETE /api/keys/:id` - Delete API key

### Proxy
- `POST /v1/messages` - Proxy requests to Claude API (uses API key in Authorization header)

## Database

The service uses SQLite with the following tables:
- `users` - User accounts
- `oauth_tokens` - Claude OAuth tokens
- `api_keys` - Generated API keys

Database file: `database.db`

## Security Notes

- API keys are hashed before storage
- OAuth tokens are automatically refreshed when expired
- JWT tokens expire after 7 days
- Change `JWT_SECRET` in production
- Use HTTPS in production

## Development

Run in development mode with auto-reload:
```bash
bun run dev
```

Run in production mode:
```bash
bun run start
```

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Browser   │─────▶│   Auth Service   │─────▶│ Anthropic OAuth │
│  Dashboard  │      │      (JWT)       │      │  (Claude Pro)   │
└─────────────┘      └──────────────────┘      └─────────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │  API Key Manager │
                     └──────────────────┘
                              │
                              ▼
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐
│ Team Member │─────▶│   Proxy Service  │─────▶│  Claude API     │
│ (API Key)   │      │ (Token Refresh)  │      │  (with OAuth)   │
└─────────────┘      └──────────────────┘      └─────────────────┘
```

## Deployment

### Deploy to Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/your-template-id)

1. **Prerequisites**:
   - GitHub repository with this code
   - Railway account (free tier available)

2. **Deployment Steps**:

   a. **Connect Repository**:
   - Go to [Railway Dashboard](https://railway.app/dashboard)
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose your `claude-proxy-service` repository

   b. **Configure Environment Variables**:
   - `JWT_SECRET`: Generate secure random string (e.g., `openssl rand -base64 32`)
   - `CLAUDE_CLIENT_ID`: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
   - `PORT`: Not needed (Railway auto-provides)
   - `NODE_ENV`: `production`

   c. **Add Persistent Volume**:
   - In Railway dashboard, go to your service settings
   - Click "Variables" → "Volumes"
   - Add volume:
     - Mount Path: `/app/database.db`
     - Size: 512 MB (or more if needed)

   d. **Deploy**:
   - Railway will automatically build and deploy
   - Your service will be available at `https://your-service.up.railway.app`

3. **Post-Deployment**:
   - Update your application's allowed origins if needed
   - Test the endpoints using your Railway URL
   - Monitor logs in Railway dashboard

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `JWT_SECRET` - Secret key for JWT token signing
- `CLAUDE_CLIENT_ID` - Anthropic OAuth client ID
- `PORT` - Server port (default: 3000)

### Costs

Railway offers:
- **Free Tier**: $5 credits, then $1/month
- 0.5 GB RAM, 1 vCPU, 0.5 GB storage
- Perfect for small teams

## License

MIT
