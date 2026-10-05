import { useEffect, useState } from 'react';
import { getAuthToken, subscribeAuthToken } from '../services/api/authToken.js';

export function useAuthToken() {
  const [token, setToken] = useState(() => getAuthToken());
  useEffect(() => subscribeAuthToken((next) => setToken(next ?? null)), []);
  return token;
}
