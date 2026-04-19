import { Buffer } from "buffer";
// Expose Buffer globally so @solana/web3.js + wallet-adapter internals find it.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { App } from "./App.tsx";
import "./styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";

const queryClient = new QueryClient();
const endpoint = import.meta.env.VITE_RPC_URL ?? clusterApiUrl("devnet");
const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <App />
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
