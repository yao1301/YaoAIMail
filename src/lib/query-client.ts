import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { reportAppError } from "./appErrors";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => reportAppError(error, "读取失败") }),
  mutationCache: new MutationCache({ onError: (error) => reportAppError(error, "修改未完成") }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});
