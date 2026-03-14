import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { writeFileSync, existsSync, readFileSync } from 'fs';

// ALL flags go to this address (Kaan's main wallet)
const MAIN_ADDRESS = '0x630c413933d84bd064e01cedd3a02f4d1acb66bf8075ebcd82659297206a6442';
const PACKAGE_ID = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const CLOCK_ID = '0x6';
const NUM_FARMERS = 10;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function isWindowOpen(): { open: boolean; remaining: number } {
  const now = Math.floor(Date.now() / 1000);
  const t = now % 3600;
  if (t < 300) return { open: true, remaining: 300 - t };
  if (t >= 1800 && t < 2100) return { open: true, remaining: 2100 - t };
  return { open: false, remaining: 0 };
}

(async () => {
  // Generate or load farmer keypairs
  const farmersFile = 'friend_farmers.json';
  let farmers: { address: string; privateKey: string }[];

  if (existsSync(farmersFile)) {
    farmers = JSON.parse(readFileSync(farmersFile, 'utf-8'));
    console.log(`Loaded ${farmers.length} existing farmers`);
  } else {
    farmers = [];
    for (let i = 0; i < NUM_FARMERS; i++) {
      const kp = new Ed25519Keypair();
      farmers.push({
        address: kp.getPublicKey().toSuiAddress(),
        privateKey: kp.getSecretKey(),
      });
    }
    writeFileSync(farmersFile, JSON.stringify(farmers, null, 2));
    console.log(`Generated ${NUM_FARMERS} farmer addresses. Fund them with SUI from https://faucet.sui.io/`);
  }

  console.log('\nFarmer addresses (fund ALL of these):');
  for (let i = 0; i < farmers.length; i++) {
    console.log(`  F${i + 1}: ${farmers[i].address}`);
  }
  console.log(`\nAll flags will be sent to: ${MAIN_ADDRESS}`);

  // Check balances
  console.log('\nChecking balances...');
  const funded: typeof farmers = [];
  for (const f of farmers) {
    try {
      const resp = await fetch('https://fullnode.testnet.sui.io:443', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getBalance',
          params: [f.address, '0x2::sui::SUI'] }),
      });
      const data = await resp.json() as any;
      const bal = parseInt(data.result?.totalBalance || '0');
      if (bal > 0) {
        console.log(`  ✅ ${f.address.slice(0, 20)}... ${(bal / 1e9).toFixed(1)} SUI`);
        funded.push(f);
      } else {
        console.log(`  ❌ ${f.address.slice(0, 20)}... NOT FUNDED`);
      }
    } catch {
      console.log(`  ❓ ${f.address.slice(0, 20)}... check failed`);
    }
  }

  if (funded.length === 0) {
    console.log('\nNo funded farmers! Fund the addresses above, then run this script again.');
    return;
  }

  console.log(`\n🚀 Starting ${funded.length} farmers. Flags → ${MAIN_ADDRESS.slice(0, 16)}...`);
  console.log('Press Ctrl+C to stop.\n');

  // Farm loop for each funded farmer
  const farmLoop = async (privateKey: string, id: number) => {
    const keypair = Ed25519Keypair.fromSecretKey(privateKey);
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
    let total = 0;

    while (true) {
      const { open, remaining } = isWindowOpen();
      if (!open) {
        const now = Math.floor(Date.now() / 1000);
        const t = now % 3600;
        const nextWindow = t < 1800 ? 1800 - t : 3600 - t;
        if (id === 1) console.log(`Window closed. Next in ${(nextWindow / 60).toFixed(0)} min. Total across all: check logs`);
        await sleep(Math.min(nextWindow * 1000 + 2000, 30000));
        continue;
      }

      if (remaining < 3) { await sleep(3000); continue; }

      const tx = new Transaction();
      const batchSize = 50;
      for (let i = 0; i < batchSize; i++) {
        const flag = tx.moveCall({
          target: `${PACKAGE_ID}::moving_window::extract_flag`,
          arguments: [tx.object(CLOCK_ID)],
        });
        tx.transferObjects([flag], MAIN_ADDRESS);
      }

      try {
        const result = await client.signAndExecuteTransaction({
          signer: keypair, transaction: tx, include: { effects: true },
        });
        if (result.$kind === 'Transaction') {
          total += batchSize;
          console.log(`[F${id}] +${batchSize} (total: ${total})`);
        }
      } catch (e: any) {
        const msg = e.message?.slice(0, 60) || '';
        if (msg.includes('insufficient')) {
          console.log(`[F${id}] OUT OF GAS. Refund: ${keypair.getPublicKey().toSuiAddress()}`);
          await sleep(60000);
        } else {
          await sleep(3000);
        }
      }
      await sleep(500);
    }
  };

  await Promise.all(funded.map((f, i) => farmLoop(f.privateKey, i + 1)));
})();
