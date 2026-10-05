// Mock auth store — simulates session state for mock mode.
import { MOCK_USERS } from './mockUsers.js';

// Default session mirrors the legacy MOCK_USER in SessionContext.
export const DEFAULT_SESSION = {
  id: 'user_riya',
  name: 'Riya Sharma',
  email: 'riya.sharma@bluetokai.com',
  role: 'supervisor',       // Default view-as role (matches legacy default)
  cityScope: 'Mumbai',
  tenantId: 'bt-tenant-001',
  token: 'mock.jwt.token',
};

// Simple credential check — in mock mode any known email + 'password' works.
export function mockLogin({ email, password }) {
  const user = MOCK_USERS.find(u => u.email === email);
  if (!user || password !== 'password') {
    throw new Error('Invalid credentials');
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    cityScope: user.city,
    tenantId: user.tenantId,
    token: 'mock.jwt.token',
    permissions: [],
  };
}
