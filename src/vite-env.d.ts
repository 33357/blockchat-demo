/// <reference types="vite/client" />

type EthereumRequestArgs = {
  method: string;
  params?: unknown[];
};

type EthereumProvider = {
  request<T = unknown>(args: EthereumRequestArgs): Promise<T>;
  on(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on(event: "chainChanged", listener: (chainId: string) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

interface Window {
  ethereum?: EthereumProvider;
}
