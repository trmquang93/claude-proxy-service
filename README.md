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

## License

MIT
