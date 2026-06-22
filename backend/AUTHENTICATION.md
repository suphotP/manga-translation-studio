# Authentication & Authorization System

## Overview

The manga-editor-web backend implements a comprehensive JWT-based authentication system with Role-Based Access Control (RBAC). This system provides secure user management, token-based authentication, and fine-grained permission control.

## Features

- **JWT Authentication**: Secure token-based authentication with access and refresh tokens
- **Role-Based Access Control (RBAC)**: Three-tier permission system (Admin, Editor, Viewer)
- **Password Security**: Bcrypt hashing with configurable password policies
- **Token Management**: Refresh token rotation and revocation
- **User Management**: CRUD operations for user accounts
- **Protected Routes**: Middleware-based route protection
- **Development Tools**: Seed admin user endpoint for testing
- **Provider-Neutral Identity Metadata**: Local users carry `authProvider`, optional `externalSubject`, and `emailVerified` fields so a later Auth0/OIDC/SAML migration can link external identities without changing project APIs.

## Architecture

### Components

1. **Authentication Service** (`services/auth.service.ts`)
   - User CRUD operations
   - Password hashing and validation
   - JWT token generation and verification
   - Refresh token management

2. **Authentication Middleware** (`middleware/auth.middleware.ts`)
   - JWT verification
   - Role-based authorization
   - Permission checking
   - Context attachment

3. **Authentication Routes** (`routes/auth.ts`)
   - Login/Logout
   - Registration
   - Token refresh
   - Password management
   - User management (admin only)

4. **Type Definitions** (`types/auth.ts`)
   - User interface
   - JWT payload interface
   - Role permissions
   - Permission checking utilities

## User Roles

### Admin
- Full system access
- User management (CRUD)
- Settings management
- All project operations
- AI generation

### Editor
- Create and manage projects
- Generate AI translations
- Export and import projects
- Cannot manage users or settings

### Viewer
- Read-only project access
- Export projects
- Cannot modify or create content

## API Endpoints

### Public Routes

#### POST /api/auth/register
Register a new user account.

Public registration always creates an `editor` user. Role assignment is only allowed when the request is made by an authenticated admin, so a public client cannot self-register as `admin`.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe"
}
```

**Response:** 201 Created
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "editor",
    "authProvider": "local",
    "emailVerified": false,
    "isActive": true,
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "tokens": {
    "accessToken": "jwt-access-token",
    "refreshToken": "jwt-refresh-token"
  }
}
```

#### POST /api/auth/login
Authenticate with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response:** 200 OK
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "editor",
    "authProvider": "local",
    "emailVerified": false,
    "isActive": true
  },
  "tokens": {
    "accessToken": "jwt-access-token",
    "refreshToken": "jwt-refresh-token"
  }
}
```

#### POST /api/auth/refresh
Refresh access token using refresh token.

**Request:**
```json
{
  "refreshToken": "jwt-refresh-token"
}
```

**Response:** 200 OK
```json
{
  "tokens": {
    "accessToken": "new-jwt-access-token",
    "refreshToken": "new-jwt-refresh-token"
  },
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "role": "editor"
  }
}
```

## Auth0/SSO Migration Direction

The current production path should stay custom/local until the workspace UX, billing, and core collaboration flows are stable. The user model is intentionally ready for a later provider bridge:

- `authProvider: "local"` is the default for password users.
- `authProvider: "auth0" | "oidc" | "saml" | "google" | "github"` can identify future external accounts.
- `externalSubject` stores the stable provider subject such as an Auth0 `sub`.
- `emailVerified` lets the app distinguish imported or SSO-verified addresses from local prototype accounts.

For a future Auth0 or enterprise SSO rollout, add a callback/JWT validation layer that maps the external provider subject to an existing user with `findUserByExternalIdentity`, links an existing email after an explicit trust decision, then issues the app's normal project API session. This keeps project, asset, AI, and collaboration APIs independent from the identity vendor.

### Protected Routes

All protected routes require a valid JWT token in the Authorization header:

```
Authorization: Bearer <access-token>
```

#### GET /api/auth/me
Get current user information.

**Response:** 200 OK
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "role": "editor",
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "lastLogin": "2024-01-01T12:00:00.000Z"
}
```

#### POST /api/auth/logout
Invalidate refresh token.

**Request:**
```json
{
  "refreshToken": "jwt-refresh-token"
}
```

**Response:** 200 OK
```json
{
  "message": "Logged out successfully"
}
```

#### POST /api/auth/change-password
Change current user's password.

**Request:**
```json
{
  "oldPassword": "OldPass123!",
  "newPassword": "NewPass456!"
}
```

**Response:** 200 OK
```json
{
  "message": "Password changed successfully"
}
```

### Admin Routes

#### GET /api/auth/users
List all users (admin only).

**Response:** 200 OK
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "role": "editor",
      "isActive": true,
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### GET /api/auth/users/:id
Get specific user (admin only).

#### PATCH /api/auth/users/:id
Update user (admin only).

**Request:**
```json
{
  "name": "Jane Doe",
  "role": "admin",
  "isActive": true
}
```

#### DELETE /api/auth/users/:id
Delete user (admin only).

#### POST /api/auth/users/:id/disable
Disable user account (admin only).

#### POST /api/auth/users/:id/enable
Enable user account (admin only).

## Password Policy

Default password requirements:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

Configure via environment variables:
```bash
PASSWORD_MIN_LENGTH=8
PASSWORD_REQUIRE_UPPERCASE=true
PASSWORD_REQUIRE_LOWERCASE=true
PASSWORD_REQUIRE_NUMBERS=true
PASSWORD_REQUIRE_SPECIAL=true
```

## Token Expiration

- **Access Token**: 15 minutes (configurable via `JWT_ACCESS_EXPIRY`)
- **Refresh Token**: 7 days (configurable via `JWT_REFRESH_EXPIRY`)

## Frontend Integration

### Login Flow

```typescript
// 1. Login
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});

const { user, tokens } = await response.json();

// 2. Store tokens
localStorage.setItem('accessToken', tokens.accessToken);
localStorage.setItem('refreshToken', tokens.refreshToken);

// 3. Use access token for API calls
const data = await fetch('/api/project/new', {
  headers: {
    'Authorization': `Bearer ${tokens.accessToken}`
  }
});
```

### Token Refresh Flow

```typescript
// Check if access token is expired
try {
  const data = await fetch('/api/project/new', {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
} catch (error) {
  // Refresh token
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  const { tokens } = await response.json();
  localStorage.setItem('accessToken', tokens.accessToken);
  localStorage.setItem('refreshToken', tokens.refreshToken);
}
```

## Development

### Seed Admin User

In development mode, you can create an initial admin user:

```bash
curl -X POST http://localhost:3001/api/dev/seed-admin
```

Response:
```json
{
  "message": "Admin user created",
  "user": {
    "id": "uuid",
    "email": "admin@mangaeditor.local",
    "name": "System Administrator",
    "role": "admin"
  },
  "credentials": {
    "email": "admin@mangaeditor.local",
    "password": "Admin123!"
  }
}
```

### Testing

Run authentication tests:

```bash
bun test backend/src/__tests__/auth.test.ts
```

## Security Considerations

1. **JWT Secret**: Always use a strong, random secret in production
2. **HTTPS**: Always use HTTPS in production to protect tokens
3. **Token Storage**: Consider using httpOnly cookies instead of localStorage
4. **Rate Limiting**: Implement rate limiting on authentication endpoints
5. **Password Reset**: Implement password reset functionality for production
6. **Account Lockout**: Consider implementing account lockout after failed attempts

## Migration Guide

### For Existing Projects

If you have existing projects without authentication:

1. Update your backend to include authentication middleware
2. Create admin user via `/api/dev/seed-admin`
3. Create user accounts for your team
4. Update frontend to include login flow
5. Migrate existing projects to admin account

### Route Protection

Existing routes can be protected by adding middleware:

```typescript
import { authMiddleware, requirePermission } from './middleware/auth.middleware.js';

// Protect route with authentication
app.use("/api/project", authMiddleware);

// Protect with specific permission
app.use("/api/ai", requirePermission("generate:ai"));
```

## Troubleshooting

### "Unauthorized: Invalid token" Error
- Check that the token hasn't expired
- Verify the JWT_SECRET matches between token generation and verification
- Ensure the Authorization header format is correct: `Bearer <token>`

### "Forbidden: Insufficient permissions" Error
- Check the user's role
- Verify the required permission for the route
- Ensure the user is active (not disabled)

### Password Validation Errors
- Ensure password meets all requirements
- Check environment variables for password policy
- Verify the password policy configuration
