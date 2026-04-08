import axios, { AxiosError } from 'axios';
import { TimeoutError } from '../middleware/errorHandler.js';

// Shared axios instance with timeout interceptor applied
const axiosClient = axios.create();

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

axiosClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (axios.isAxiosError(error)) {
      // Handle timeout
      if (error.code === 'ECONNABORTED') {
        return Promise.reject(new TimeoutError('Request to MiniMax API timed out'));
      }

      // Handle 429 rate limit with retry
      if (error.response?.status === 429 && error.config) {
        const retryCount = (error.config as unknown as { _retryCount?: number })._retryCount || 0;
        if (retryCount < MAX_RETRIES) {
          const retryAfter = error.response?.headers?.['retry-after'];
          const delay = retryAfter
            ? parseInt(retryAfter as string, 10) * 1000
            : BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
          console.log(`[AxiosClient] Rate limited, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          (error.config as unknown as { _retryCount: number })._retryCount = retryCount + 1;
          await new Promise(resolve => setTimeout(resolve, delay));
          return axiosClient(error.config);
        }
      }
    }
    return Promise.reject(error);
  }
);

export { axiosClient };
