import {
  Commitment,
  ConfirmedSignatureInfo,
  Connection,
  ParsedInstruction,
  PublicKey,
} from "@solana/web3.js";
import dotenv from "dotenv";
import * as fs from "fs";
import WebSocket from "ws";

dotenv.config();

// I have free helius plan and my rpc does not allow me to use getParsedTransactions as batched call,
// i need to use getParsedTransaction. Also this rpc is not the best so if you will choose account
// wchich has a lot of txs you might get rate limited.

interface ISlotFile {
  mainnet: { lastBlock: number; lastProcessedTx: string };
  devnet: { lastBlock: number; lastProcessedTx: string };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const API_KEY = "1d46bde4-6fae-4740-9403-08854d0f5127";
const RPC_URL: Record<string, string> = {
  ["mainnet-beta"]: "https://mainnet.helius-rpc.com/?api-key=",
  ["devnet"]: "https://devnet.helius-rpc.com/?api-key=",
};

const WEBSOCKET_URL: Record<string, string> = {
  ["mainnet-beta"]: "wss://mainnet.helius-rpc.com/?api-key=",
  ["devnet"]: "wss://devnet.helius-rpc.com/?api-key=",
};
const NULL_SIG =
  "1111111111111111111111111111111111111111111111111111111111111111";

const extractAndLogTransfers = async (connection: Connection, sig: string) => {
  const tx = await connection.getParsedTransaction(sig, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta || !tx.meta.innerInstructions) return;
  for (const innerIx of tx.meta.innerInstructions) {
    for (const ix of innerIx.instructions) {
      const typedIx = ix as ParsedInstruction;
      if (typedIx.parsed) {
        const info = typedIx.parsed.info;
        const source = info.source;
        const destination = info.destination;
        const authority = info.authority;

        let mint: string | undefined = info.mint;
        let uiAmount: number | undefined;

        if (info.tokenAmount) {
          const amount = Number(info.tokenAmount.amount || 0);
          const decimals = Number(info.tokenAmount.decimals || 0);
          uiAmount = amount / 10 ** decimals;
          mint = info.mint;
        } else {
          const meta = tx.meta.preTokenBalances?.find(
            (item) => item.owner === authority
          );
          const decimals = meta?.uiTokenAmount.decimals ?? 0;
          const amount = Number(info.amount || 0);
          uiAmount = amount / 10 ** decimals;
          mint = mint || meta?.mint;
        }
        if (!!sig && !!source && !!destination && !!uiAmount && !!mint)
          console.log(
            `SIG: ${sig} FROM: ${source} TO: ${destination} AMOUNT: ${uiAmount} MINT: ${mint}`
          );
      }
    }
  }
  await sleep(100); // Sleep for rpc durability
};

const catchUp = async (
  connection: Connection,
  lastProcessedTx: string,
  address: PublicKey,
  net: string,
  slotFile: ISlotFile
) => {
  let txBefore: string | undefined = undefined;
  const allSigsInfos: ConfirmedSignatureInfo[] = [];
  while (true) {
    const sigsInfos = await connection.getSignaturesForAddress(address, {
      before: txBefore,
      until: lastProcessedTx,
    });
    if (sigsInfos.length !== 0) {
      allSigsInfos.push(...sigsInfos);
    } else {
      break;
    }
    if (sigsInfos[sigsInfos.length - 1].signature === lastProcessedTx) break;
    txBefore = sigsInfos[sigsInfos.length - 1].signature;

    await sleep(10); // Sleep for rpc durability
  }
  for (const info of allSigsInfos.reverse()) {
    if (info.signature !== lastProcessedTx) {
      await extractAndLogTransfers(connection, info.signature);
      fs.writeFileSync(
        "./src/data/last_block.json",
        JSON.stringify(
          {
            mainnet:
              net === "mainnet-beta"
                ? { lastBlock: info.slot, lastProcessedTx: info.signature }
                : slotFile.mainnet,
            devnet:
              net === "mainnet-beta"
                ? slotFile.devnet
                : { lastBlock: info.slot, lastProcessedTx: info.signature },
          },
          null,
          2
        )
      );
      await sleep(10); // Sleep for rpc durability
    }
  }
};

const main = async () => {
  let net = process.env.NETWORK;
  let commitment = process.env.COMMITMENT;
  let address = process.env.ADDRESS;

  if (!address) {
    console.log("Please setup address to listen to in .env file");
    return;
  } else {
    try {
      new PublicKey(address);
    } catch {
      console.log("Wrong address to listen to (not a solana publickey)");
      return;
    }
  }
  if (!commitment) commitment = "finalized" as Commitment;
  if (!net) net = "mainnet-beta";

  const rpcUrl = RPC_URL[net];
  const websocketUrl = WEBSOCKET_URL[net];

  if (!rpcUrl || !websocketUrl) {
    console.log("wrong network variable in .env");
    return;
  }

  let connection: Connection;

  try {
    connection = new Connection(rpcUrl + API_KEY, {
      commitment: commitment as Commitment,
    });
  } catch {
    console.log("Wrong commitment variable in .env");
    return;
  }
  let ws: WebSocket | null = null;
  let lastSeenSlot = 0;

  // Ai helped mi with websocket reconnect handling: connecting, real time reconnecting, etc.
  // Fallbacks flow and gaps handling and everything else is mine.
  // I also used helius docs for thi integration https://www.helius.dev/docs/rpc/websocket/stream-pump-amm-data

  const subscribe = () => {
    if (!ws) return;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [address] }, { commitment }],
      })
    );

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "slotSubscribe",
        params: [],
      })
    );
  };

  const scheduleReconnect = async () => {
    try {
      ws?.terminate();
    } catch {}
    ws = null;

    await sleep(1000);

    connect();

    try {
      const slotFile = JSON.parse(
        fs.readFileSync("./src/data/last_block.json", "utf-8")
      ) as ISlotFile;
      const { lastProcessedTx } =
        net === "mainnet-beta" ? slotFile.mainnet : slotFile.devnet;

      if (lastProcessedTx) {
        await catchUp(
          connection,
          lastProcessedTx,
          new PublicKey(address),
          net,
          slotFile
        );
      }
    } catch (e) {}
  };

  const connect = () => {
    ws = new WebSocket(websocketUrl + API_KEY);

    ws.on("open", () => {
      subscribe();
    });

    ws.on("message", async (raw) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!data || !data.method || !data.params) return;

      if (data.method === "slotNotification") {
        const slot: number = data.params.result.slot;
        if (lastSeenSlot && slot > lastSeenSlot + 1) {
          const slotFile = JSON.parse(
            fs.readFileSync("./src/data/last_block.json", "utf-8")
          ) as ISlotFile;
          const { lastProcessedTx } =
            net === "mainnet-beta" ? slotFile.mainnet : slotFile.devnet;

          if (lastProcessedTx) {
            await catchUp(
              connection,
              lastProcessedTx,
              new PublicKey(address),
              net,
              slotFile
            );
          }
        }
        lastSeenSlot = slot;
        return;
      }

      if (data.method === "logsNotification") {
        const { context, value } = data.params.result;
        const slot: number = context.slot;
        const sig: string = value.signature;

        if (!sig || sig === NULL_SIG) return;

        if (lastSeenSlot && slot > lastSeenSlot + 1) {
          const slotFile = JSON.parse(
            fs.readFileSync("./src/data/last_block.json", "utf-8")
          ) as ISlotFile;
          const { lastProcessedTx } =
            net === "mainnet-beta" ? slotFile.mainnet : slotFile.devnet;

          if (lastProcessedTx) {
            await catchUp(
              connection,
              lastProcessedTx,
              new PublicKey(address),
              net,
              slotFile
            );
          }
        }

        await extractAndLogTransfers(connection, sig);

        const slotFile = JSON.parse(
          fs.readFileSync("./src/data/last_block.json", "utf-8")
        ) as ISlotFile;

        fs.writeFileSync(
          "./src/data/last_block.json",
          JSON.stringify(
            {
              mainnet:
                net === "mainnet-beta"
                  ? { lastBlock: slot, lastProcessedTx: sig }
                  : slotFile.mainnet,
              devnet:
                net === "mainnet-beta"
                  ? slotFile.devnet
                  : { lastBlock: slot, lastProcessedTx: sig },
            },
            null,
            2
          )
        );

        lastSeenSlot = slot;
      }
    });

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();
};

main();
