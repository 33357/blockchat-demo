import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent } from "react";
import ethIcon from "./assets/tokens/eth.png";
import usdcIcon from "./assets/tokens/usdc.png";
import usdtIcon from "./assets/tokens/usdt.png";

const STORAGE_KEY = "token-chat-state-v2";
const LEFT_ROOMS_STORAGE_KEY = "token-chat-left-rooms-v1";
const ADMIN_ELECTION_MIGRATION_KEY = "token-chat-admin-election-migration-v1";
const ADMIN_ELECTION_AUTOVOTE_MIGRATION_KEY = "token-chat-admin-election-autovote-migration-v1";
const ETHEREUM_CHAIN_ID = "0x1";

type Token = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind?: "native" | "erc20";
  icon?: string;
};

type ChatMessage = {
  id: string;
  room: string;
  address: string;
  text: string;
  rawBalance: string;
  symbol: string;
  createdAt: number;
  redPacketId?: string;
};

type RedPacket = {
  id: string;
  sender: string;
  totalAmount: string;
  perClaim: string;
  maxClaims: number;
  minHolding: string;
  claimed: Record<string, string>;
  createdAt: number;
};

type ImpeachmentData = {
  targetAdmin: string;
  initiator: string;
  startedAt: number;
  votes: string[];
  stakeAmount: string;
};

type ElectionData = {
  startedAt: number;
  votes: Record<string, string>;
};

type PersistedState = {
  tokens: Token[];
  messages: Record<string, ChatMessage[]>;
  holders: Record<string, Record<string, string>>;
  electedAdmins: Record<string, string>;
  activeElections: Record<string, ElectionData>;
  impeachedAdmins: Record<string, string[]>;
  activeImpeachment: Record<string, ImpeachmentData>;
  redPackets: Record<string, RedPacket>;
};

type Rank = number | "-";
type AvatarStyle = CSSProperties & Record<`--${string}`, string>;

const NATIVE_ETH_ADDRESS = "native:ethereum";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const REMOVED_DEFAULT_TOKEN_ADDRESSES = new Set(
  [
    "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"
  ].map(normalizeAddress)
);

const DEMO_USERS = [
  "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  "0x39B1ed4C8fC77d5F1cCd1e8Ad5F5E0A8d87F7E6d",
  "0x5fB0c90a9D80255b6a330bC31b35F0125fF2aF44",
  "0xC0FFEE254729296a45a3885639AC7E10F9d54979"
];

const MESSAGE_ICONS = ["👍", "🔥", "🚀", "💎", "👀", "✅", "🎯", "⚡", "❤️", "😂", "👏", "🙏", "🧠", "💬", "🌕", "📈"];

const DEFAULT_TOKENS: Token[] = [
  {
    address: NATIVE_ETH_ADDRESS,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    kind: "native",
    icon: ethIcon
  },
  {
    address: USDC_ADDRESS,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    kind: "erc20",
    icon: usdcIcon
  },
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    kind: "erc20",
    icon: usdtIcon
  }
];

const createInitialState = (): PersistedState => createSeededState();

const loadState = (): PersistedState => {
  const fallback = createInitialState();
  const leftRooms = getLeftRooms();

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<PersistedState> | null;
    if (!saved) {
      return {
        ...fallback,
        tokens: fallback.tokens.filter((token) => !leftRooms.has(normalizeAddress(token.address)))
      };
    }

    const tokenMap = new Map(DEFAULT_TOKENS.map((token) => [normalizeAddress(token.address), token]));
    for (const token of saved.tokens || []) {
      const tokenAddress = normalizeAddress(token.address);
      if (!REMOVED_DEFAULT_TOKEN_ADDRESSES.has(tokenAddress) && !leftRooms.has(tokenAddress)) {
        const defaultToken = tokenMap.get(tokenAddress);
        tokenMap.set(tokenAddress, defaultToken ? { ...token, ...defaultToken, icon: defaultToken.icon } : token);
      }
    }
    for (const roomKey of leftRooms) {
      tokenMap.delete(roomKey);
    }

    const savedElectedAdmins = { ...(saved.electedAdmins || {}) };
    if (!localStorage.getItem(ADMIN_ELECTION_MIGRATION_KEY)) {
      delete savedElectedAdmins[normalizeAddress(USDC_ADDRESS)];
      localStorage.setItem(ADMIN_ELECTION_MIGRATION_KEY, "done");
    }
    const savedActiveElections = { ...(saved.activeElections || {}) };
    if (!localStorage.getItem(ADMIN_ELECTION_AUTOVOTE_MIGRATION_KEY)) {
      for (const roomKey of Object.keys(savedActiveElections)) {
        savedActiveElections[roomKey] = {
          ...savedActiveElections[roomKey],
          votes: {}
        };
      }
      localStorage.setItem(ADMIN_ELECTION_AUTOVOTE_MIGRATION_KEY, "done");
    }

    return {
      tokens: Array.from(tokenMap.values()),
      messages: filterRemovedRooms(mergeMessages(fallback.messages, saved.messages || {})),
      holders: filterRemovedRooms(mergeHolders(fallback.holders, saved.holders || {})),
      electedAdmins: filterRemovedRooms({ ...fallback.electedAdmins, ...savedElectedAdmins }),
      activeElections: filterRemovedRooms(savedActiveElections),
      impeachedAdmins: saved.impeachedAdmins || {},
      activeImpeachment: saved.activeImpeachment || {},
      redPackets: saved.redPackets || {}
    };
  } catch {
    return fallback;
  }
};

export default function App() {
  const [persisted, setPersisted] = useState<PersistedState>(() => loadState());
  const [account, setAccount] = useState("");
  const [activeRoom, setActiveRoom] = useState("");
  const [chainId, setChainId] = useState("");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [tokenAddress, setTokenAddress] = useState("");
  const [messageText, setMessageText] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [isAddingToken, setIsAddingToken] = useState(false);
  const [notice, setNotice] = useState("");
  const [profileAddress, setProfileAddress] = useState("");
  const [roomManageOpen, setRoomManageOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [rpPanelOpen, setRpPanelOpen] = useState(false);
  const [rpAmount, setRpAmount] = useState("");
  const [rpCount, setRpCount] = useState("3");
  const [rpMinHolding, setRpMinHolding] = useState("");
  const messageListRef = useRef<HTMLOListElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const selectedToken = useMemo(
    () => persisted.tokens.find((token) => normalizeAddress(token.address) === normalizeAddress(activeRoom)),
    [activeRoom, persisted.tokens]
  );
  const roomMessages = selectedToken ? persisted.messages[normalizeAddress(selectedToken.address)] || [] : [];
  const roomHolders = selectedToken ? getRoomHolders(persisted.holders, selectedToken.address) : [];
  const selectedBalance = selectedToken
    ? balances[selectedToken.address] || balances[normalizeAddress(selectedToken.address)]
    : undefined;
  const canChat = Boolean(
    selectedToken && account && meetsSpeechRequirement(selectedBalance, getSpeechRequirement(selectedToken))
  );
  const roomAdmin = selectedToken
    ? getEffectiveAdmin(persisted.holders, persisted.electedAdmins, persisted.impeachedAdmins, selectedToken.address)
    : "";

  const commitState = useCallback((next: PersistedState) => {
    setPersisted(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const resetApp = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEFT_ROOMS_STORAGE_KEY);
    localStorage.removeItem(ADMIN_ELECTION_MIGRATION_KEY);
    localStorage.removeItem(ADMIN_ELECTION_AUTOVOTE_MIGRATION_KEY);
    const fresh = createInitialState();
    setPersisted(fresh);
    setAccount("");
    setChainId("");
    setBalances({});
    setActiveRoom(fresh.tokens[0]?.address || "");
    setMessageText("");
    setNotice("");
    setProfileAddress("");
    setRoomManageOpen(false);
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }, []);

  const hydrateLocalBalances = useCallback(
    (walletAddress: string, sourceState = persisted) => {
      const nextBalances: Record<string, string> = {};
      for (const token of sourceState.tokens) {
        const localBalance = sourceState.holders[normalizeAddress(token.address)]?.[normalizeAddress(walletAddress)];
        if (localBalance) {
          nextBalances[token.address] = localBalance;
          nextBalances[normalizeAddress(token.address)] = localBalance;
        }
      }
      setBalances(nextBalances);

      setActiveRoom((current) => {
        if (
          current &&
          sourceState.tokens.some((token) => normalizeAddress(token.address) === normalizeAddress(current))
        )
          return current;
        return sourceState.tokens[0]?.address || "";
      });
    },
    [persisted]
  );

  const scanBalancesFor = useCallback(
    async (walletAddress: string, sourceState = persisted) => {
      if (!walletAddress || !window.ethereum) return;

      setIsScanning(true);
      try {
        const nextBalances: Record<string, string> = {};
        let nextState: PersistedState = {
          ...sourceState,
          tokens: [...sourceState.tokens],
          holders: { ...sourceState.holders }
        };

        for (const token of nextState.tokens) {
          const [decimals, symbol, rawBalance] = isNativeToken(token)
            ? [18, "ETH", await readNativeBalance(walletAddress)]
            : await Promise.all([
                token.decimals ?? readTokenDecimals(token.address),
                token.symbol || readTokenSymbol(token.address),
                readTokenBalance(token.address, walletAddress)
              ]);
          token.decimals = Number(decimals);
          token.symbol = symbol || token.symbol || "TOKEN";
          token.name = token.name || token.symbol;
          nextBalances[token.address] = rawBalance;
          nextBalances[normalizeAddress(token.address)] = rawBalance;
          nextState = rememberHolder(nextState, token.address, walletAddress, rawBalance);
        }

        setBalances(nextBalances);
        commitState(nextState);

        setActiveRoom((current) => {
          if (
            current &&
            nextState.tokens.some((token) => normalizeAddress(token.address) === normalizeAddress(current))
          )
            return current;
          return nextState.tokens[0]?.address || "";
        });
      } catch (error) {
        showNotice(getErrorMessage(error, "扫描余额失败"));
      } finally {
        setIsScanning(false);
      }
    },
    [commitState, persisted, showNotice]
  );

  const switchToEthereum = useCallback(async () => {
    if (!window.ethereum) return;

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ETHEREUM_CHAIN_ID }]
      });
      setChainId(ETHEREUM_CHAIN_ID);
    } catch (error) {
      showNotice(getErrorMessage(error, "请切换到 Ethereum Mainnet 后再扫描余额"));
      throw error;
    }
  }, [showNotice]);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      showNotice("没有检测到 Web3 钱包，请先安装 MetaMask 或兼容钱包。");
      return;
    }

    try {
      const accounts = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" });
      const nextChainId = await window.ethereum.request<string>({ method: "eth_chainId" });
      const nextAccount = accounts[0] || "";
      setAccount(nextAccount);
      setChainId(nextChainId);

      if (nextChainId !== ETHEREUM_CHAIN_ID) {
        await switchToEthereum();
      }

      hydrateLocalBalances(nextAccount);
      await scanBalancesFor(nextAccount);
    } catch (error) {
      showNotice(getErrorMessage(error, "连接钱包失败"));
    }
  }, [hydrateLocalBalances, scanBalancesFor, showNotice, switchToEthereum]);

  const disconnectWallet = useCallback(() => {
    setAccount("");
    setBalances({});
    setActiveRoom("");
    setProfileAddress("");
    setRoomManageOpen(false);
    setMessageText("");
    setEmojiPickerOpen(false);
    setRpPanelOpen(false);
    showNotice("已断开钱包");
  }, [showNotice]);

  const addToken = useCallback(async () => {
    const address = normalizeAddress(tokenAddress);
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      showNotice("请输入有效 ERC-20 合约地址。");
      return;
    }

    if (persisted.tokens.some((token) => normalizeAddress(token.address) === address)) {
      showNotice("这个 token 已经在列表里。");
      return;
    }

    if (!account || !window.ethereum) {
      showNotice("先连接钱包，再添加并扫描 token。");
      return;
    }

    setIsAddingToken(true);
    try {
      const [symbol, decimals, rawBalance] = await Promise.all([
        readTokenSymbol(address),
        readTokenDecimals(address),
        readTokenBalance(address, account)
      ]);
      const token: Token = {
        address,
        symbol: symbol || "TOKEN",
        name: symbol || "Custom Token",
        decimals: Number(decimals),
        kind: "erc20"
      };
      const nextBalances = {
        ...balances,
        [address]: rawBalance
      };
      let nextState: PersistedState = {
        ...persisted,
        tokens: [...persisted.tokens, token],
        holders: { ...persisted.holders }
      };
      nextState = rememberHolder(nextState, address, account, rawBalance);
      unmarkRoomLeft(address);
      setBalances(nextBalances);
      commitState(nextState);
      setTokenAddress("");

      setActiveRoom(address);
    } catch (error) {
      showNotice(getErrorMessage(error, "搜索 token 失败，请确认它是 ERC-20"));
    } finally {
      setIsAddingToken(false);
    }
  }, [account, balances, commitState, persisted, showNotice, tokenAddress]);

  const searchToken = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void addToken();
    },
    [addToken]
  );

  const leaveRoom = useCallback(
    (token: Token) => {
      const roomKey = normalizeAddress(token.address);
      markRoomLeft(roomKey);

      const nextTokens = persisted.tokens.filter((item) => normalizeAddress(item.address) !== roomKey);
      const nextState: PersistedState = {
        ...persisted,
        tokens: nextTokens
      };

      commitState(nextState);
      setRoomManageOpen(false);
      setActiveRoom((current) => {
        if (normalizeAddress(current) !== roomKey) return current;
        return nextTokens[0]?.address || "";
      });
      showNotice(`已退出 ${token.symbol} 聊天室`);
    },
    [commitState, persisted, showNotice]
  );

  const sendMessage = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = messageText.trim();
      if (!text || !account || !selectedToken || !canChat) return;

      const roomKey = normalizeAddress(selectedToken.address);
      const rawBalance = balances[selectedToken.address] || balances[roomKey] || "0";
      const message: ChatMessage = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        room: roomKey,
        address: account,
        text,
        rawBalance,
        symbol: selectedToken.symbol,
        createdAt: Date.now()
      };
      let nextState: PersistedState = {
        ...persisted,
        messages: {
          ...persisted.messages,
          [roomKey]: [...(persisted.messages[roomKey] || []), message]
        },
        holders: { ...persisted.holders }
      };
      nextState = rememberHolder(nextState, selectedToken.address, account, rawBalance);
      commitState(nextState);
      setMessageText("");
      setEmojiPickerOpen(false);
    },
    [account, balances, canChat, commitState, messageText, persisted, selectedToken]
  );

  const startImpeachment = useCallback(
    (token: Token) => {
      if (!account) return;
      const roomKey = normalizeAddress(token.address);
      const currentAdmin = getEffectiveAdmin(
        persisted.holders,
        persisted.electedAdmins,
        persisted.impeachedAdmins,
        token.address
      );
      if (!currentAdmin) return;
      if (persisted.activeImpeachment[roomKey]) return;

      const myRawBalance = persisted.holders[roomKey]?.[normalizeAddress(account)] || "0";
      const stakeAmount = getImpeachStake(myRawBalance);
      const myAfterStake =
        BigInt(myRawBalance) >= BigInt(stakeAmount)
          ? (BigInt(myRawBalance) - BigInt(stakeAmount)).toString()
          : myRawBalance;

      const nextState: PersistedState = {
        ...persisted,
        holders: {
          ...persisted.holders,
          [roomKey]: { ...persisted.holders[roomKey], [normalizeAddress(account)]: myAfterStake }
        },
        activeImpeachment: {
          ...persisted.activeImpeachment,
          [roomKey]: {
            targetAdmin: normalizeAddress(currentAdmin),
            initiator: normalizeAddress(account),
            startedAt: Date.now(),
            votes: [normalizeAddress(account)],
            stakeAmount
          }
        }
      };
      commitState(nextState);
      showNotice(`已启动弹劾，已支付 ${formatTokenAmount(stakeAmount, token.decimals)} ${token.symbol}`);
    },
    [account, commitState, persisted, showNotice]
  );

  const startAdminElection = useCallback(
    (token: Token) => {
      const roomKey = normalizeAddress(token.address);
      if (persisted.activeElections[roomKey]) return;
      if (getRoomHolders(persisted.holders, token.address).length === 0) {
        showNotice("暂无可选成员");
        return;
      }

      commitState({
        ...persisted,
        activeElections: {
          ...persisted.activeElections,
          [roomKey]: {
            startedAt: Date.now(),
            votes: {}
          }
        }
      });
      showNotice(`已开启 ${token.symbol} 管理员选举，投票窗口 24 小时`);
    },
    [commitState, persisted, showNotice]
  );

  const castAdminElectionVote = useCallback(
    (token: Token, candidateAddress: string) => {
      if (!account) return;
      const roomKey = normalizeAddress(token.address);
      const election = persisted.activeElections[roomKey];
      if (!election) return;
      if (election.votes[normalizeAddress(account)]) {
        showNotice("你已经投过票了");
        return;
      }

      commitState({
        ...persisted,
        activeElections: {
          ...persisted.activeElections,
          [roomKey]: {
            ...election,
            votes: {
              ...election.votes,
              [normalizeAddress(account)]: normalizeAddress(candidateAddress)
            }
          }
        }
      });
      showNotice("已提交管理员选票");
    },
    [account, commitState, persisted, showNotice]
  );

  const finalizeAdminElection = useCallback(
    (token: Token) => {
      const roomKey = normalizeAddress(token.address);
      const election = persisted.activeElections[roomKey];
      if (!election) return;

      const winner = getElectionWinner(election, persisted.holders[roomKey] || {});
      const { [roomKey]: _removed, ...restElections } = persisted.activeElections;
      const nextState: PersistedState = {
        ...persisted,
        activeElections: restElections
      };

      if (winner) {
        nextState.electedAdmins = {
          ...persisted.electedAdmins,
          [roomKey]: winner
        };
      }

      commitState(nextState);
      showNotice(winner ? "管理员选举已结束" : "选举结束，暂无有效选票");
    },
    [commitState, persisted, showNotice]
  );

  const castImpeachVote = useCallback(
    (token: Token) => {
      if (!account) return;
      const roomKey = normalizeAddress(token.address);
      const impeachment = persisted.activeImpeachment[roomKey];
      if (!impeachment) return;
      if (impeachment.votes.includes(normalizeAddress(account))) return;

      const newVotes = [...impeachment.votes, normalizeAddress(account)];
      const allHolders = persisted.holders[roomKey] || {};
      const totalBalance = Object.values(allHolders).reduce((sum, bal) => sum + BigInt(bal || "0"), 0n);
      const votedBalance = newVotes.reduce((sum, addr) => sum + BigInt(allHolders[addr] || "0"), 0n);
      const passes = totalBalance > 0n && votedBalance * 2n > totalBalance;

      let nextState: PersistedState;
      if (passes) {
        const existing = persisted.impeachedAdmins[roomKey] || [];
        const initiatorAddr = normalizeAddress(impeachment.initiator);
        const initiatorBalance = persisted.holders[roomKey]?.[initiatorAddr] || "0";
        const refunded = (BigInt(initiatorBalance) + BigInt(impeachment.stakeAmount)).toString();
        const { [roomKey]: _removed, ...restImpeachment } = persisted.activeImpeachment;
        nextState = {
          ...persisted,
          holders: {
            ...persisted.holders,
            [roomKey]: { ...persisted.holders[roomKey], [initiatorAddr]: refunded }
          },
          impeachedAdmins: { ...persisted.impeachedAdmins, [roomKey]: [...existing, impeachment.targetAdmin] },
          activeImpeachment: restImpeachment
        };
        showNotice(`弹劾成功！费用已返还，${token.symbol} 聊天室触发提前选举`);
      } else {
        nextState = {
          ...persisted,
          activeImpeachment: { ...persisted.activeImpeachment, [roomKey]: { ...impeachment, votes: newVotes } }
        };
        showNotice("已投票支持弹劾");
      }
      commitState(nextState);
    },
    [account, commitState, persisted, showNotice]
  );

  const cleanExpiredImpeachment = useCallback(
    (token: Token) => {
      const roomKey = normalizeAddress(token.address);
      const impeachment = persisted.activeImpeachment[roomKey];
      if (!impeachment) return;
      const { [roomKey]: _removed, ...restImpeachment } = persisted.activeImpeachment;
      const adminAddr = normalizeAddress(impeachment.targetAdmin);
      const adminBalance = persisted.holders[roomKey]?.[adminAddr] || "0";
      const adminAfter = (BigInt(adminBalance) + BigInt(impeachment.stakeAmount)).toString();
      commitState({
        ...persisted,
        holders: {
          ...persisted.holders,
          [roomKey]: { ...persisted.holders[roomKey], [adminAddr]: adminAfter }
        },
        activeImpeachment: restImpeachment
      });
      showNotice(`弹劾失败，费用已转给管理员`);
    },
    [commitState, persisted, showNotice]
  );

  const insertMessageIcon = useCallback(
    (icon: string) => {
      const composer = composerRef.current;
      const selectionStart = composer?.selectionStart ?? messageText.length;
      const selectionEnd = composer?.selectionEnd ?? messageText.length;
      const nextText = `${messageText.slice(0, selectionStart)}${icon}${messageText.slice(selectionEnd)}`.slice(0, 600);
      const nextCursor = Math.min(selectionStart + icon.length, nextText.length);

      setMessageText(nextText);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [messageText]
  );

  const sendRedPacket = useCallback(() => {
    if (!account || !selectedToken || !canChat) return;
    const roomKey = normalizeAddress(selectedToken.address);
    const totalRaw = tokenUnits(rpAmount || "0", selectedToken.decimals);
    const minRaw = tokenUnits(rpMinHolding || "0", selectedToken.decimals);
    const count = Math.max(1, Math.min(20, parseInt(rpCount, 10) || 1));
    if (BigInt(totalRaw) <= 0n) {
      showNotice("请输入有效金额");
      return;
    }
    const myBalance = BigInt(persisted.holders[roomKey]?.[normalizeAddress(account)] || "0");
    if (myBalance < BigInt(totalRaw)) {
      showNotice("余额不足");
      return;
    }
    const perClaim = (BigInt(totalRaw) / BigInt(count)).toString();
    const rpId = crypto.randomUUID ? crypto.randomUUID() : `rp-${Date.now()}`;
    const message: ChatMessage = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      room: roomKey,
      address: account,
      text: "发了一个红包",
      rawBalance: myBalance.toString(),
      symbol: selectedToken.symbol,
      createdAt: Date.now(),
      redPacketId: rpId
    };
    const myAfter = (myBalance - BigInt(totalRaw)).toString();
    let nextState: PersistedState = {
      ...persisted,
      messages: { ...persisted.messages, [roomKey]: [...(persisted.messages[roomKey] || []), message] },
      holders: {
        ...persisted.holders,
        [roomKey]: { ...persisted.holders[roomKey], [normalizeAddress(account)]: myAfter }
      },
      redPackets: {
        ...persisted.redPackets,
        [rpId]: {
          id: rpId,
          sender: normalizeAddress(account),
          totalAmount: totalRaw,
          perClaim,
          maxClaims: count,
          minHolding: minRaw,
          claimed: {},
          createdAt: Date.now()
        }
      }
    };
    nextState = rememberHolder(nextState, selectedToken.address, account, myAfter);
    commitState(nextState);
    setRpPanelOpen(false);
    setRpAmount("");
    setRpCount("3");
    setRpMinHolding("");
    showNotice("红包已发出");
  }, [account, canChat, commitState, persisted, rpAmount, rpCount, rpMinHolding, selectedToken, showNotice]);

  const claimRedPacket = useCallback(
    (rpId: string) => {
      if (!account || !selectedToken) return;
      const roomKey = normalizeAddress(selectedToken.address);
      const rp = persisted.redPackets[rpId];
      if (!rp) return;
      if (rp.claimed[normalizeAddress(account)]) return;
      if (Object.keys(rp.claimed).length >= rp.maxClaims) return;
      const myBalance = BigInt(persisted.holders[roomKey]?.[normalizeAddress(account)] || "0");
      if (myBalance < BigInt(rp.minHolding)) {
        showNotice(
          `需持有至少 ${formatTokenAmount(rp.minHolding, selectedToken.decimals)} ${selectedToken.symbol} 才能领取`
        );
        return;
      }
      const claimedSoFar = Object.values(rp.claimed).reduce((s, a) => s + BigInt(a), 0n);
      const isLast = Object.keys(rp.claimed).length === rp.maxClaims - 1;
      const claimAmount = isLast ? BigInt(rp.totalAmount) - claimedSoFar : BigInt(rp.perClaim);
      const myAfter = (myBalance + claimAmount).toString();
      let nextState: PersistedState = {
        ...persisted,
        holders: {
          ...persisted.holders,
          [roomKey]: { ...persisted.holders[roomKey], [normalizeAddress(account)]: myAfter }
        },
        redPackets: {
          ...persisted.redPackets,
          [rpId]: { ...rp, claimed: { ...rp.claimed, [normalizeAddress(account)]: claimAmount.toString() } }
        }
      };
      nextState = rememberHolder(nextState, selectedToken.address, account, myAfter);
      commitState(nextState);
      showNotice(`领取了 ${formatTokenAmount(claimAmount.toString(), selectedToken.decimals)} ${selectedToken.symbol}`);
    },
    [account, commitState, persisted, selectedToken, showNotice]
  );

  useEffect(() => {
    if (!window.ethereum) return;

    const refreshKnownWallet = async () => {
      try {
        const [accounts, nextChainId] = await Promise.all([
          window.ethereum!.request<string[]>({ method: "eth_accounts" }),
          window.ethereum!.request<string>({ method: "eth_chainId" })
        ]);
        const nextAccount = accounts[0] || "";
        setChainId(nextChainId);
        setAccount(nextAccount);
        if (nextAccount) hydrateLocalBalances(nextAccount);
      } catch (error) {
        showNotice(getErrorMessage(error, "读取钱包状态失败"));
      }
    };

    const handleAccountsChanged = (accounts: string[]) => {
      const nextAccount = accounts[0] || "";
      setAccount(nextAccount);
      if (nextAccount) {
        hydrateLocalBalances(nextAccount);
      } else {
        setBalances({});
        setActiveRoom("");
      }
    };

    const handleChainChanged = (nextChainId: string) => {
      setChainId(nextChainId);
      setBalances({});
      setActiveRoom("");
    };

    void refreshKnownWallet();
    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged as (...args: unknown[]) => void);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged as (...args: unknown[]) => void);
    };
  }, [hydrateLocalBalances, showNotice]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [roomMessages.length, activeRoom]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(140, composer.scrollHeight)}px`;
  }, [messageText]);

  useEffect(() => {
    setRoomManageOpen(false);
  }, [activeRoom]);

  return (
    <main className="app">
      <aside className="sidebar" aria-label="Token rooms">
        <div className="brand">
          <div className="mark">TC</div>
          <div>
            <h1>Token Chat</h1>
            <p>Web3 持仓聊天室</p>
          </div>
          <button className="reset-btn" type="button" title="重置为初始数据" onClick={resetApp}>
            ↺
          </button>
        </div>

        <section className="wallet-panel">
          <div className="wallet-state">
            {account ? (
              <Avatar
                address={account}
                rank="-"
                size="compact"
                revealAddress
                onClick={() => setProfileAddress(account)}
              />
            ) : (
              <span className="status-avatar" />
            )}
            <div>
              <strong>{account ? shortAddress(account) : "未连接钱包"}</strong>
              <small>{chainId === ETHEREUM_CHAIN_ID ? "Ethereum Mainnet" : "请切换 Ethereum Mainnet"}</small>
            </div>
          </div>
          <div className="wallet-actions">
            <button
              className="primary"
              type="button"
              onClick={account ? disconnectWallet : connectWallet}
              title={account ? "断开钱包" : "连接钱包"}
            >
              {account ? "断开" : "连接"}
            </button>
          </div>
        </section>

        {account ? (
          <>
            <section className="token-tools">
              <form className="token-search" onSubmit={searchToken} role="search">
                <span className="token-search-icon" aria-hidden="true" />
                <input
                  id="tokenAddress"
                  type="text"
                  spellCheck="false"
                  value={tokenAddress}
                  placeholder="Search"
                  aria-label="搜索 ERC-20 合约地址"
                  onChange={(event) => setTokenAddress(event.target.value)}
                />
                <button
                  className="token-search-action"
                  type="submit"
                  title="搜索 token"
                  disabled={isAddingToken || !tokenAddress.trim()}
                >
                  {isAddingToken ? "..." : "搜索"}
                </button>
              </form>
            </section>

            <nav className="room-list" aria-label="可加入聊天室">
              {persisted.tokens.map((token) => {
                const roomKey = normalizeAddress(token.address);
                const balanceValue = balances[token.address] || balances[normalizeAddress(token.address)];
                const isActive = normalizeAddress(activeRoom) === roomKey;
                const latestMessage = persisted.messages[roomKey]?.at(-1);

                return (
                  <button
                    key={roomKey}
                    className={`room-button ${isActive ? "active" : ""}`}
                    type="button"
                    onClick={() => setActiveRoom(token.address)}
                  >
                    <RoomAvatar token={token} />
                    <span className="room-copy">
                      <strong>{token.symbol} 聊天室</strong>
                      <span>{latestMessage?.text || "暂无消息"}</span>
                    </span>
                    <span className="room-side">
                      <span>
                        {balanceValue === undefined
                          ? "待扫描"
                          : `${formatTokenAmount(balanceValue, token.decimals)} ${token.symbol}`}
                      </span>
                      <time dateTime={latestMessage ? new Date(latestMessage.createdAt).toISOString() : undefined}>
                        {latestMessage ? formatTime(latestMessage.createdAt) : ""}
                      </time>
                    </span>
                  </button>
                );
              })}
            </nav>
          </>
        ) : (
          <div className="room-locked-state">
            <strong>连接钱包后显示聊天室</strong>
            <span>连接 Web3 钱包后可查看 token 房间和余额。</span>
          </div>
        )}
      </aside>

      <section className="chat">
        <header className="chat-header">
          <div className="room-heading">
            <RoomAvatar token={selectedToken} />
            <div className="room-title">
              <h2>{selectedToken ? `${selectedToken.symbol} 聊天室` : "选择聊天室"}</h2>
              <span>{roomHolders.length} members</span>
            </div>
          </div>
          <button
            className="room-more"
            type="button"
            title="管理聊天室"
            disabled={!selectedToken}
            onClick={() => setRoomManageOpen(true)}
          >
            ...
          </button>
        </header>

        {!selectedToken ? (
          <div className="empty-state">
            <h3>用钱包持仓进入对应 Token 房间</h3>
            <p>连接钱包并扫描后，符合资格的 token 会开放聊天室。发言身份使用地址头像，排名通过头像光环表达。</p>
          </div>
        ) : (
          <ol ref={messageListRef} className="messages has-room" aria-live="polite">
            {roomMessages.map((message) => {
              const isMine = normalizeAddress(message.address) === normalizeAddress(account);
              return (
                <li className={`message ${isMine ? "mine" : ""}`} key={message.id}>
                  <Avatar
                    address={message.address}
                    rank={getHolderRank(persisted.holders, message.room, message.address)}
                    size="compact"
                    onClick={() => setProfileAddress(message.address)}
                  />
                  {message.redPacketId ? (
                    <RedPacketCard
                      rp={persisted.redPackets[message.redPacketId]}
                      token={selectedToken}
                      currentAccount={account}
                      isMine={isMine}
                      onClaim={claimRedPacket}
                    />
                  ) : (
                    <div className="message-bubble">
                      <p className="message-body">{message.text}</p>
                      <time className="message-time" dateTime={new Date(message.createdAt).toISOString()}>
                        {formatTime(message.createdAt)}
                      </time>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <form className="composer" onSubmit={sendMessage}>
          <div className="composer-input">
            <button
              className="emoji-button"
              type="button"
              title="插入图标"
              disabled={!canChat}
              onClick={() => {
                setEmojiPickerOpen((open) => !open);
                setRpPanelOpen(false);
              }}
            >
              ☺
            </button>
            <button
              className="emoji-button rp-toggle"
              type="button"
              title="发红包"
              disabled={!canChat}
              onClick={() => {
                setRpPanelOpen((open) => !open);
                setEmojiPickerOpen(false);
              }}
            >
              🧧
            </button>
            <textarea
              ref={composerRef}
              rows={1}
              maxLength={600}
              value={messageText}
              placeholder={
                canChat && selectedToken ? `在 ${selectedToken.symbol} 聊天室发言` : "连接钱包并选择聊天室后发言"
              }
              disabled={!canChat}
              onChange={(event) => setMessageText(event.target.value)}
            />
          </div>
          <button className="send-button" type="submit" title="发送消息" disabled={!canChat || !messageText.trim()}>
            ↑
          </button>
          {emojiPickerOpen ? (
            <div className="emoji-panel" role="menu" aria-label="选择图标">
              {MESSAGE_ICONS.map((icon) => (
                <button key={icon} type="button" role="menuitem" onClick={() => insertMessageIcon(icon)}>
                  {icon}
                </button>
              ))}
            </div>
          ) : null}
          {rpPanelOpen && selectedToken ? (
            <div className="rp-panel">
              <h4 className="rp-panel-title">🧧 发红包</h4>
              <div className="rp-fields">
                <label className="rp-label">
                  总金额 ({selectedToken.symbol})
                  <input
                    className="rp-input"
                    type="text"
                    value={rpAmount}
                    placeholder="0.1"
                    onChange={(e) => setRpAmount(e.target.value)}
                  />
                </label>
                <label className="rp-label">
                  红包个数
                  <input
                    className="rp-input"
                    type="number"
                    min="1"
                    max="20"
                    value={rpCount}
                    onChange={(e) => setRpCount(e.target.value)}
                  />
                </label>
                <label className="rp-label">
                  最低持仓 ({selectedToken.symbol})
                  <input
                    className="rp-input"
                    type="text"
                    value={rpMinHolding}
                    placeholder="0"
                    onChange={(e) => setRpMinHolding(e.target.value)}
                  />
                </label>
              </div>
              <button className="rp-send-btn" type="button" onClick={sendRedPacket}>
                发送红包
              </button>
            </div>
          ) : null}
        </form>
      </section>

      {profileAddress ? (
        <ProfileSheet
          address={profileAddress}
          tokens={persisted.tokens}
          holders={persisted.holders}
          onClose={() => setProfileAddress("")}
        />
      ) : null}

      {roomManageOpen && selectedToken ? (
        <RoomManageSheet
          token={selectedToken}
          memberCount={roomHolders.length}
          balance={selectedBalance}
          canChat={canChat}
          members={roomHolders}
          currentAccount={account}
          adminAddress={roomAdmin}
          activeElection={persisted.activeElections[normalizeAddress(selectedToken.address)]}
          activeImpeachment={persisted.activeImpeachment[normalizeAddress(selectedToken.address)]}
          onLeave={() => leaveRoom(selectedToken)}
          onStartElection={() => startAdminElection(selectedToken)}
          onVoteElection={(candidate) => castAdminElectionVote(selectedToken, candidate)}
          onExpireElection={() => finalizeAdminElection(selectedToken)}
          onStartImpeach={() => startImpeachment(selectedToken)}
          onVoteImpeach={() => castImpeachVote(selectedToken)}
          onExpireImpeach={() => cleanExpiredImpeachment(selectedToken)}
          onClose={() => setRoomManageOpen(false)}
        />
      ) : null}

      {notice ? <div className="toast">{notice}</div> : null}
    </main>
  );
}

function RedPacketCard({
  rp,
  token,
  currentAccount,
  isMine,
  onClaim
}: {
  rp?: RedPacket;
  token: Token;
  currentAccount: string;
  isMine: boolean;
  onClaim: (id: string) => void;
}) {
  if (!rp) return <div className="rp-card rp-card-empty">红包已失效</div>;
  const claimedCount = Object.keys(rp.claimed).length;
  const myAddr = normalizeAddress(currentAccount);
  const hasClaimed = Boolean(rp.claimed[myAddr]);
  const isExhausted = claimedCount >= rp.maxClaims;
  const myClaimed = rp.claimed[myAddr];

  return (
    <div className={`rp-card ${isMine ? "rp-card-mine" : ""}`}>
      <div className="rp-card-icon">🧧</div>
      <div className="rp-card-body">
        <strong className="rp-card-title">{isMine ? "你" : shortAddress(rp.sender)}的红包</strong>
        {BigInt(rp.minHolding) > 0n && (
          <span className="rp-card-cond">
            持有 ≥ {formatTokenAmount(rp.minHolding, token.decimals)} {token.symbol}
          </span>
        )}
        <div className="rp-card-footer">
          <span className="rp-card-count">
            {claimedCount}/{rp.maxClaims} 已领
          </span>
          {isExhausted ? (
            <span className="rp-exhausted">已领完</span>
          ) : hasClaimed ? (
            <span className="rp-my-amount">+{formatTokenAmount(myClaimed, token.decimals)}</span>
          ) : (
            <button className="rp-claim-btn" type="button" onClick={() => onClaim(rp.id)}>
              领取
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RoomAvatar({ token }: { token?: Token }) {
  const seed = token ? `${token.symbol}:${token.address}` : "empty-room";
  if (token?.icon) {
    return (
      <span className="room-avatar token-icon" aria-hidden="true">
        <img src={token.icon} alt="" />
      </span>
    );
  }

  return (
    <span className="room-avatar" style={getAvatarStyle(seed)} aria-hidden="true">
      <span>{token?.symbol.slice(0, 2) || "TC"}</span>
    </span>
  );
}

const IMPEACH_DURATION_MS = 24 * 60 * 60 * 1000;
const ELECTION_DURATION_MS = 24 * 60 * 60 * 1000;

function RoomManageSheet({
  token,
  memberCount,
  members,
  currentAccount,
  adminAddress,
  activeElection,
  activeImpeachment,
  onLeave,
  onStartElection,
  onVoteElection,
  onExpireElection,
  onStartImpeach,
  onVoteImpeach,
  onExpireImpeach,
  onClose
}: {
  token: Token;
  memberCount: number;
  balance?: string;
  canChat?: boolean;
  members: [string, string][];
  currentAccount: string;
  adminAddress: string;
  activeElection?: ElectionData;
  activeImpeachment?: ImpeachmentData;
  onLeave: () => void;
  onStartElection: () => void;
  onVoteElection: (candidateAddress: string) => void;
  onExpireElection: () => void;
  onStartImpeach: () => void;
  onVoteImpeach: () => void;
  onExpireImpeach: () => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!activeImpeachment && !activeElection) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeElection, activeImpeachment]);

  const adminLabel = adminAddress
    ? normalizeAddress(adminAddress) === normalizeAddress(currentAccount)
      ? "你"
      : shortAddress(adminAddress)
    : "暂无管理员";

  const myRawBalance = members.find(([a]) => normalizeAddress(a) === normalizeAddress(currentAccount))?.[1] || "0";
  const myBalance = BigInt(myRawBalance);
  const isAdmin = Boolean(adminAddress) && normalizeAddress(adminAddress) === normalizeAddress(currentAccount);

  const stakeRaw = getImpeachStake(myRawBalance);
  const canShowImpeach = Boolean(adminAddress) && !isAdmin && !activeImpeachment;

  const remainingMs = activeImpeachment ? activeImpeachment.startedAt + IMPEACH_DURATION_MS - now : 0;
  const isExpired = activeImpeachment ? remainingMs <= 0 : false;
  const electionRemainingMs = activeElection ? activeElection.startedAt + ELECTION_DURATION_MS - now : 0;
  const isElectionExpired = activeElection ? electionRemainingMs <= 0 : false;

  useEffect(() => {
    if (isExpired) onExpireImpeach();
  }, [isExpired, onExpireImpeach]);

  useEffect(() => {
    if (isElectionExpired) onExpireElection();
  }, [isElectionExpired, onExpireElection]);

  const hasVoted = activeImpeachment?.votes.includes(normalizeAddress(currentAccount)) ?? false;
  const canVote = Boolean(activeImpeachment) && !isExpired && !hasVoted && !isAdmin && myBalance > 0n;
  const myElectionVote = activeElection?.votes[normalizeAddress(currentAccount)];
  const canElectionVote = Boolean(activeElection) && !isElectionExpired && Boolean(currentAccount);

  const totalBalance = members.reduce((sum, [, bal]) => sum + BigInt(bal || "0"), 0n);
  const votedBalance = activeImpeachment
    ? activeImpeachment.votes.reduce((sum, addr) => {
        const entry = members.find(([a]) => a === addr);
        return sum + BigInt(entry?.[1] || "0");
      }, 0n)
    : 0n;
  const impeachPct = totalBalance > 0n ? Number((votedBalance * 10000n) / totalBalance) / 100 : 0;

  return (
    <div className="profile-backdrop" role="presentation" onClick={onClose}>
      <section
        className="manage-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="管理聊天室"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="sheet-close" type="button" onClick={onClose} title="关闭">
          ×
        </button>
        <div className="manage-head">
          <RoomAvatar token={token} />
          <div>
            <div className="profile-kicker">管理聊天室</div>
            <h3>{token.symbol} 聊天室</h3>
            <span>{memberCount} members</span>
          </div>
        </div>

        <div className="manage-admin-section">
          {adminAddress ? (
            <>
              <span className="manage-section-label">当前管理员</span>
              <div className="manage-admin-card">
                <Avatar address={adminAddress} rank={1} size="compact" />
                <div className="manage-admin-info">
                  <strong>{adminLabel}</strong>
                  <span>剩余任期 {getAdminTermRemaining(token.address, adminAddress)}</span>
                </div>
                {canShowImpeach && !confirming ? (
                  <button
                    className="impeach-btn"
                    type="button"
                    title={`启动弹劾，费用 ${formatTokenAmount(stakeRaw, token.decimals)} ${token.symbol}`}
                    onClick={() => setConfirming(true)}
                  >
                    弹劾
                  </button>
                ) : activeImpeachment && !isExpired ? (
                  <span className="impeach-voted-badge">弹劾中</span>
                ) : null}
              </div>

              {confirming && (
                <div className="impeach-dialog-backdrop" role="presentation" onClick={() => setConfirming(false)}>
                  <div
                    className="impeach-dialog"
                    role="alertdialog"
                    aria-modal="true"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <h4>确认启动弹劾？</h4>
                    <p>
                      启动需支付{" "}
                      <strong>
                        {formatTokenAmount(stakeRaw, token.decimals)} {token.symbol}
                      </strong>
                      。
                    </p>
                    <p>投票窗口 24 小时，超过半数持仓支持即弹劾成功，费用全额返还；否则费用归管理员。</p>
                    <div className="impeach-dialog-actions">
                      <button type="button" onClick={() => setConfirming(false)}>
                        取消
                      </button>
                      <button
                        className="impeach-dialog-ok"
                        type="button"
                        onClick={() => {
                          setConfirming(false);
                          onStartImpeach();
                        }}
                      >
                        确认支付
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {activeImpeachment && !isExpired && (
                <div className="impeach-active">
                  <div className="impeach-active-header">
                    <span className="impeach-active-label">弹劾投票中</span>
                    <span className="impeach-countdown">{formatCountdown(remainingMs)}</span>
                  </div>
                  <div className="impeach-bar-row">
                    <div className="impeach-bar-track">
                      <div className="impeach-bar-fill" style={{ width: `${Math.min(impeachPct * 2, 100)}%` }} />
                      <div className="impeach-bar-threshold" />
                    </div>
                    <span className={`impeach-pct${impeachPct > 50 ? " impeach-pct-passed" : ""}`}>
                      {impeachPct.toFixed(1)}%
                    </span>
                  </div>
                  {canVote ? (
                    <button className="impeach-vote-btn" type="button" onClick={onVoteImpeach}>
                      投票支持弹劾
                    </button>
                  ) : hasVoted ? (
                    <p className="impeach-status">你已投票</p>
                  ) : isAdmin ? (
                    <p className="impeach-status">你是被弹劾方</p>
                  ) : null}
                </div>
              )}
            </>
          ) : activeElection && !isElectionExpired ? (
            <div className="election-active">
              <div className="impeach-active-header">
                <span className="impeach-active-label">管理员选举投票中</span>
                <span className="impeach-countdown">{formatCountdown(electionRemainingMs)}</span>
              </div>
              <span className="election-status">
                {myElectionVote ? `你已投票给 ${shortAddress(myElectionVote)}` : "在成员列表中选择候选人投票"}
              </span>
            </div>
          ) : (
            <div className="manage-no-admin">
              <div>
                <span>当前管理员</span>
                <strong>暂无管理员</strong>
              </div>
              <button type="button" onClick={onStartElection}>
                开启投票选举管理员
              </button>
            </div>
          )}
        </div>

        <div className="manage-list">
          <div>
            <span>发言要求</span>
            <strong>
              {formatTokenAmount("0", token.decimals)} {token.symbol}
            </strong>
          </div>
          <div>
            <span>地址类型</span>
            <strong>{isNativeToken(token) ? "Native" : "ERC-20"}</strong>
          </div>
        </div>

        <div className="manage-members">
          <span>全部人员</span>
          {members.length > 0 ? (
            <ul>
              {members.map(([address], index) => {
                const rank = index + 1;
                const isCurrentAccount = normalizeAddress(address) === normalizeAddress(currentAccount);
                return (
                  <li key={address}>
                    <Avatar address={address} rank={rank} size="compact" />
                    <div>
                      <strong>{isCurrentAccount ? "你" : shortAddress(address)}</strong>
                      <span>排名 {rank}</span>
                    </div>
                    {activeElection &&
                    !isElectionExpired &&
                    (!myElectionVote || myElectionVote === normalizeAddress(address)) ? (
                      <button
                        className="member-vote-btn"
                        type="button"
                        disabled={!canElectionVote || Boolean(myElectionVote)}
                        onClick={() => onVoteElection(address)}
                      >
                        {myElectionVote ? "已投" : "投票"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>暂无成员</p>
          )}
        </div>

        <div className="manage-actions">
          <button className="danger" type="button" onClick={onLeave}>
            退出聊天室
          </button>
        </div>
      </section>
    </div>
  );
}

function ProfileSheet({
  address,
  tokens,
  holders,
  onClose
}: {
  address: string;
  tokens: Token[];
  holders: PersistedState["holders"];
  onClose: () => void;
}) {
  const profileRanks = getProfileRanks(tokens, holders, address);

  return (
    <div className="profile-backdrop" role="presentation" onClick={onClose}>
      <section
        className="profile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="个人信息"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="profile-close" type="button" onClick={onClose} title="关闭">
          关闭
        </button>
        <div className="profile-hero">
          <Avatar address={address} rank="-" />
          <div>
            <div className="profile-kicker">个人信息</div>
            <h3>{shortAddress(address)}</h3>
          </div>
        </div>

        <div className="profile-section">
          <span>Token 排名</span>
          {profileRanks.length > 0 ? (
            <ul className="profile-ranks">
              {profileRanks.map((entry) => (
                <li key={entry.token.address}>
                  <strong>{entry.token.symbol}</strong>
                  <b>{entry.rank}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p className="profile-empty">暂无持仓排名</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Avatar({
  address,
  rank,
  size = "default",
  revealAddress = false,
  onClick
}: {
  address: string;
  rank: Rank;
  size?: "default" | "compact";
  revealAddress?: boolean;
  onClick?: () => void;
}) {
  const label = revealAddress
    ? rank === "-"
      ? shortAddress(address)
      : `${shortAddress(address)} ${getRankLabel(rank)}`
    : getRankLabel(rank);
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!onClick) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <span
      className={`avatar ${getRankClass(rank)} ${size === "compact" ? "compact" : ""} ${onClick ? "clickable" : ""}`}
      style={getAvatarStyle(address)}
      title={label}
      aria-label={label}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <span className="avatar-core" />
      {rank !== "-" ? <span className="avatar-rank">{rank}</span> : null}
    </span>
  );
}

function createSeededState(): PersistedState {
  const ethRoom = normalizeAddress(NATIVE_ETH_ADDRESS);
  const usdcRoom = normalizeAddress(USDC_ADDRESS);
  const baseTime = Date.now() - 1000 * 60 * 28;

  return {
    tokens: DEFAULT_TOKENS,
    holders: {
      [ethRoom]: {
        [normalizeAddress(DEMO_USERS[0])]: tokenUnits("18.5", 18),
        [normalizeAddress(DEMO_USERS[1])]: tokenUnits("7.2", 18),
        [normalizeAddress(DEMO_USERS[2])]: tokenUnits("3.1", 18),
        [normalizeAddress(DEMO_USERS[3])]: tokenUnits("0.9", 18)
      },
      [usdcRoom]: {
        [normalizeAddress(DEMO_USERS[1])]: tokenUnits("9250", 6),
        [normalizeAddress(DEMO_USERS[4])]: tokenUnits("4180", 6),
        [normalizeAddress(DEMO_USERS[2])]: tokenUnits("1260", 6)
      }
    },
    messages: {
      [ethRoom]: [
        createDemoMessage(
          "seed-eth-1",
          ethRoom,
          DEMO_USERS[0],
          "ETH 今天这个房间终于不空了。",
          tokenUnits("18.5", 18),
          "ETH",
          baseTime
        ),
        createDemoMessage(
          "seed-eth-2",
          ethRoom,
          DEMO_USERS[1],
          "光环排名看起来比直接晒余额舒服很多。",
          tokenUnits("7.2", 18),
          "ETH",
          baseTime + 1000 * 60 * 4
        ),
        createDemoMessage(
          "seed-eth-3",
          ethRoom,
          DEMO_USERS[2],
          "我喜欢这个头像，匿名但能认出来。",
          tokenUnits("3.1", 18),
          "ETH",
          baseTime + 1000 * 60 * 9
        ),
        createDemoMessage(
          "seed-eth-4",
          ethRoom,
          DEMO_USERS[3],
          "等接实时后端就能变成真正群聊了。",
          tokenUnits("0.9", 18),
          "ETH",
          baseTime + 1000 * 60 * 15
        )
      ],
      [usdcRoom]: [
        createDemoMessage(
          "seed-usdc-1",
          usdcRoom,
          DEMO_USERS[1],
          "USDC 房间适合聊稳定币和支付。",
          tokenUnits("9250", 6),
          "USDC",
          baseTime + 1000 * 60 * 2
        ),
        createDemoMessage(
          "seed-usdc-2",
          usdcRoom,
          DEMO_USERS[4],
          "只显示排名，不显示余额，这个设定更克制。",
          tokenUnits("4180", 6),
          "USDC",
          baseTime + 1000 * 60 * 8
        ),
        createDemoMessage(
          "seed-usdc-3",
          usdcRoom,
          DEMO_USERS[2],
          "进房间以后气泡样式挺像 TG。",
          tokenUnits("1260", 6),
          "USDC",
          baseTime + 1000 * 60 * 18
        )
      ]
    },
    electedAdmins: {
      [ethRoom]: normalizeAddress(DEMO_USERS[0])
    },
    activeElections: {},
    impeachedAdmins: {},
    activeImpeachment: {},
    redPackets: {}
  };
}

function createDemoMessage(
  id: string,
  room: string,
  address: string,
  text: string,
  rawBalance: string,
  symbol: string,
  createdAt: number
): ChatMessage {
  return {
    id,
    room,
    address,
    text,
    rawBalance,
    symbol,
    createdAt
  };
}

function mergeMessages(seedMessages: PersistedState["messages"], savedMessages: PersistedState["messages"]) {
  const merged: PersistedState["messages"] = {};
  const roomKeys = new Set([...Object.keys(seedMessages), ...Object.keys(savedMessages)]);

  for (const roomKey of roomKeys) {
    const seen = new Set<string>();
    merged[roomKey] = [...(seedMessages[roomKey] || []), ...(savedMessages[roomKey] || [])].filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  }

  return merged;
}

function mergeHolders(seedHolders: PersistedState["holders"], savedHolders: PersistedState["holders"]) {
  const merged: PersistedState["holders"] = {};
  const roomKeys = new Set([...Object.keys(seedHolders), ...Object.keys(savedHolders)]);

  for (const roomKey of roomKeys) {
    merged[roomKey] = {
      ...(seedHolders[roomKey] || {}),
      ...(savedHolders[roomKey] || {})
    };
  }

  return merged;
}

function filterRemovedRooms<T>(rooms: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(rooms).filter(([roomKey]) => !REMOVED_DEFAULT_TOKEN_ADDRESSES.has(normalizeAddress(roomKey)))
  );
}

function getLeftRooms() {
  try {
    return new Set(
      (JSON.parse(localStorage.getItem(LEFT_ROOMS_STORAGE_KEY) || "[]") as string[]).map(normalizeAddress)
    );
  } catch {
    return new Set<string>();
  }
}

function saveLeftRooms(leftRooms: Set<string>) {
  localStorage.setItem(LEFT_ROOMS_STORAGE_KEY, JSON.stringify(Array.from(leftRooms)));
}

function markRoomLeft(tokenAddress: string) {
  const leftRooms = getLeftRooms();
  leftRooms.add(normalizeAddress(tokenAddress));
  saveLeftRooms(leftRooms);
}

function unmarkRoomLeft(tokenAddress: string) {
  const leftRooms = getLeftRooms();
  leftRooms.delete(normalizeAddress(tokenAddress));
  saveLeftRooms(leftRooms);
}

function rememberHolder(
  state: PersistedState,
  tokenAddress: string,
  holderAddress: string,
  rawBalance: string
): PersistedState {
  const tokenKey = normalizeAddress(tokenAddress);
  const holderKey = normalizeAddress(holderAddress);
  return {
    ...state,
    holders: {
      ...state.holders,
      [tokenKey]: {
        ...(state.holders[tokenKey] || {}),
        [holderKey]: rawBalance || "0"
      }
    }
  };
}

function getRoomHolders(holders: PersistedState["holders"], tokenAddress: string) {
  return Object.entries(holders[normalizeAddress(tokenAddress)] || {})
    .filter(([, rawBalance]) => BigInt(rawBalance || "0") > 0n)
    .sort((a, b) => compareBigIntDesc(a[1], b[1]));
}

function getHolderRank(holders: PersistedState["holders"], tokenAddress: string, holderAddress: string) {
  const normalizedHolder = normalizeAddress(holderAddress);
  const index = getRoomHolders(holders, tokenAddress).findIndex(([address]) => address === normalizedHolder);
  return index >= 0 ? index + 1 : "-";
}

function getProfileRanks(tokens: Token[], holders: PersistedState["holders"], holderAddress: string) {
  return tokens
    .map((token) => ({
      token,
      rank: getHolderRank(holders, token.address, holderAddress)
    }))
    .filter((entry): entry is { token: Token; rank: number } => entry.rank !== "-")
    .sort((a, b) => a.rank - b.rank);
}

function getEffectiveAdmin(
  holders: PersistedState["holders"],
  electedAdmins: PersistedState["electedAdmins"],
  impeachedAdmins: PersistedState["impeachedAdmins"],
  tokenAddress: string
): string {
  const roomKey = normalizeAddress(tokenAddress);
  const impeached = new Set((impeachedAdmins[roomKey] || []).map(normalizeAddress));
  const electedAdmin = normalizeAddress(electedAdmins[roomKey] || "");
  if (electedAdmin && !impeached.has(electedAdmin)) return electedAdmin;
  if (roomKey === normalizeAddress(USDC_ADDRESS)) return "";
  return getRoomHolders(holders, tokenAddress).find(([addr]) => !impeached.has(normalizeAddress(addr)))?.[0] || "";
}

function getElectionWinner(election: ElectionData, holders: Record<string, string>) {
  const scores: Record<string, bigint> = {};

  for (const [voter, candidate] of Object.entries(election.votes)) {
    const voterBalance = BigInt(holders[normalizeAddress(voter)] || "0");
    const voterWeight = voterBalance > 0n ? voterBalance : 1n;
    const candidateAddress = normalizeAddress(candidate);
    if (voterWeight <= 0n || !holders[candidateAddress]) continue;
    scores[candidateAddress] = (scores[candidateAddress] || 0n) + voterWeight;
  }

  return Object.entries(scores).sort((a, b) => compareBigIntDesc(a[1].toString(), b[1].toString()))[0]?.[0] || "";
}

function getImpeachStake(rawBalance: string): string {
  const bal = BigInt(rawBalance || "0");
  const stake = bal / 100n;
  return (stake > 0n ? stake : 1n).toString();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "已结束";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function getAdminTermRemaining(tokenAddress: string, adminAddress: string) {
  const hash = hashString(normalizeAddress(tokenAddress) + normalizeAddress(adminAddress));
  const days = 7 + (hash % 24);
  const hours = (hash >> 8) % 24;
  return `${days} 天 ${hours} 小时`;
}

function getRankClass(rank: Rank) {
  if (rank === 1) return "rank-first";
  if (rank === 2) return "rank-second";
  if (rank === 3) return "rank-third";
  if (rank !== "-") return "rank-member";
  return "rank-none";
}

function getRankLabel(rank: Rank) {
  if (rank === 1) return "领跑光环";
  if (rank === 2) return "先锋光环";
  if (rank === 3) return "焦点光环";
  if (rank !== "-") return "成员光环";
  return "暂无光环";
}

function hasPositiveBalance(balances: Record<string, string>, tokenAddress: string) {
  return BigInt(balances[tokenAddress] || balances[normalizeAddress(tokenAddress)] || "0") > 0n;
}

function getSpeechRequirement(_token: Token) {
  return "0";
}

function meetsSpeechRequirement(rawBalance: string | undefined, requiredBalance: string) {
  const required = BigInt(requiredBalance || "0");
  if (required === 0n) return true;
  return BigInt(rawBalance || "0") >= required;
}

async function readTokenBalance(tokenAddress: string, holderAddress: string) {
  const data = `0x70a08231${stripHex(holderAddress).padStart(64, "0")}`;
  const result = await ethCall(tokenAddress, data);
  return BigInt(result || "0x0").toString();
}

async function readNativeBalance(holderAddress: string) {
  if (!window.ethereum) throw new Error("没有检测到 Web3 钱包。");
  const result = await window.ethereum.request<string>({
    method: "eth_getBalance",
    params: [holderAddress, "latest"]
  });
  return BigInt(result || "0x0").toString();
}

async function readTokenDecimals(tokenAddress: string) {
  const result = await ethCall(tokenAddress, "0x313ce567");
  return Number(BigInt(result || "0x12"));
}

async function readTokenSymbol(tokenAddress: string) {
  const result = await ethCall(tokenAddress, "0x95d89b41");
  return decodeAbiString(result) || "TOKEN";
}

async function ethCall(to: string, data: string) {
  if (!window.ethereum) throw new Error("没有检测到 Web3 钱包。");
  return window.ethereum.request<string>({
    method: "eth_call",
    params: [{ to, data }, "latest"]
  });
}

function decodeAbiString(hex: string) {
  if (!hex || hex === "0x") return "";

  try {
    const clean = stripHex(hex);
    if (clean.length === 64) {
      return hexToAscii(clean);
    }

    const offset = Number.parseInt(clean.slice(0, 64), 16);
    const lengthStart = offset * 2;
    const length = Number.parseInt(clean.slice(lengthStart, lengthStart + 64), 16);
    return hexToAscii(clean.slice(lengthStart + 64, lengthStart + 64 + length * 2));
  } catch {
    return "";
  }
}

function hexToAscii(hex: string) {
  const bytes = hex.match(/.{1,2}/g) || [];
  return bytes
    .map((byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .join("")
    .replace(/\0/g, "")
    .trim();
}

function compareBigIntDesc(a: string, b: string) {
  const left = BigInt(a || "0");
  const right = BigInt(b || "0");
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function tokenUnits(value: string, decimals: number) {
  const [whole = "0", fraction = ""] = value.split(".");
  const normalizedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || "0")).toString();
}

function formatTokenAmount(rawBalance = "0", decimals = 18) {
  const raw = BigInt(rawBalance || "0");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toLocaleString();

  const fractionText = fraction.toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString()}${fractionText ? `.${fractionText}` : ""}`;
}

function normalizeAddress(address = "") {
  return address.trim().toLowerCase();
}

function getAvatarStyle(address: string): AvatarStyle {
  const hash = hashString(normalizeAddress(address));
  const hueA = hash % 360;
  const hueB = (hueA + 84 + ((hash >> 5) % 70)) % 360;
  const hueC = (hueA + 192 + ((hash >> 11) % 48)) % 360;

  return {
    "--avatar-a": `hsl(${hueA} 74% 46%)`,
    "--avatar-b": `hsl(${hueB} 68% 58%)`,
    "--avatar-c": `hsl(${hueC} 76% 38%)`,
    "--avatar-turn": `${hash % 360}deg`,
    "--avatar-cut": `${28 + (hash % 22)}%`
  };
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isNativeToken(token: Token) {
  return token.kind === "native" || normalizeAddress(token.address) === NATIVE_ETH_ADDRESS;
}

function stripHex(value = "") {
  return value.replace(/^0x/i, "");
}

function shortAddress(address = "") {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message || fallback : fallback;
}
