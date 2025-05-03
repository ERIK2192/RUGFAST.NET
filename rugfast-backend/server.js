const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { createMint, TOKEN_PROGRAM_ID, createSetAuthorityInstruction, AuthorityType, getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');
// NYTT: Importera Market från @project-serum/serum för att skapa marknader
const { Market } = require('@project-serum/serum');

const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const fs = require('fs');

// Läs och validera nyckel-filen
const keypairData = JSON.parse(fs.readFileSync('/Users/Erik/.config/solana/devnet-keypair.json', 'utf8'));
const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
const ownerPublicKey = ownerKeypair.publicKey;

console.log("Owner Public Key (for testing):", ownerPublicKey.toBase58());

// Försök hämta test-SOL med retry
async function ensureFunds(maxRetries = 3) {
    let balance = await connection.getBalance(ownerPublicKey);
    let retries = 0;
    while (balance < 0.1 * LAMPORTS_PER_SOL && retries < maxRetries) {
        console.log(`Airdropping 1 SOL to ${ownerPublicKey.toBase58()} (Attempt ${retries + 1})`);
        try {
            await connection.requestAirdrop(ownerPublicKey, 1 * LAMPORTS_PER_SOL);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Vänta på bekräftelse
            balance = await connection.getBalance(ownerPublicKey);
        } catch (error) {
            console.error("Airdrop failed:", error.message);
            retries++;
            if (retries === maxRetries) {
                console.warn("Max airdrop retries reached. Manual airdrop recommended.");
            }
            await new Promise(resolve => setTimeout(resolve, 2000)); // Vänta innan nästa försök
        }
    }
    return balance;
}

app.post('/create-token', async (req, res) => {
    try {
        const { publicKey, tokenName, tokenSymbol, totalSupply, decimals, revokeMint, revokeFreeze, revokeUpdate, totalCost } = req.body;
        console.log("Received data:", { publicKey, totalCost });

        let userPublicKey;
        try {
            userPublicKey = new PublicKey(publicKey);
        } catch (e) {
            if (publicKey === "TestWallet123...456") {
                console.log("Test mode detected - skipping public key validation");
                userPublicKey = ownerPublicKey;
            } else {
                throw new Error("Invalid public key format");
            }
        }

        if (publicKey === "TestWallet123...456") {
            console.log("Simulated payment of", totalCost, "SOL for test mode");

            // Försök säkerställa fonder
            //await ensureFunds();

            // Skapa en ny token
            const mint = await createMint(
                connection,
                ownerKeypair,
                ownerPublicKey, // Mint authority (kan revoceras senare)
                revokeFreeze ? null : ownerPublicKey, // Freeze authority
                decimals,
                TOKEN_PROGRAM_ID
            );

            // Skapa ett tillhörande token-konto
            const tokenAccount = await getOrCreateAssociatedTokenAccount(
                connection,
                ownerKeypair,
                mint,
                ownerPublicKey
            );

            // Mint den angivna supplyen
            const amount = BigInt(totalSupply) * BigInt(Math.pow(10, decimals)); // Använd BigInt för stora tal
            await mintTo(connection, ownerKeypair, mint, tokenAccount.address, ownerPublicKey, amount);

            // Sätt revoke options
            if (revokeMint || revokeFreeze || revokeUpdate) {
                const tx = new Transaction();
                if (revokeMint) tx.add(createSetAuthorityInstruction(mint, ownerPublicKey, AuthorityType.MintTokens, null));
                if (revokeFreeze) tx.add(createSetAuthorityInstruction(mint, ownerPublicKey, AuthorityType.FreezeAccount, null));
                if (revokeUpdate) tx.add(createSetAuthorityInstruction(mint, ownerPublicKey, AuthorityType.AccountOwner, null));
                if (tx.instructions.length > 0) {
                    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
                    tx.feePayer = ownerPublicKey;
                    await sendAndConfirmTransaction(connection, tx, [ownerKeypair]);
                }
            }

            res.json({ success: true, signature: mint.toBase58(), message: `Token created on Devnet: ${mint.toBase58()}` });
            return;
        }

        // Riktig betalning (för framtida användning)
        const lamports = totalCost * LAMPORTS_PER_SOL;
        const paymentTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: userPublicKey,
                toPubkey: ownerPublicKey,
                lamports,
            })
        );
        paymentTx.feePayer = userPublicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        paymentTx.recentBlockhash = blockhash;

        const serializedTx = paymentTx.serialize({ requireAllSignatures: false });
        res.json({ success: true, transaction: serializedTx.toString('base64') });
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

// NYTT: Endpoint för att skapa en marknad på OpenBook/Serum
app.post('/create-market', async (req, res) => {
    try {
        const { tokenMint, userPublicKey } = req.body;

        // Validera inputs
        if (!tokenMint || !userPublicKey) {
            throw new Error('Missing tokenMint or userPublicKey');
        }

        const tokenMintPublicKey = new PublicKey(tokenMint);
        const userPubkey = new PublicKey(userPublicKey);

        // Definiera bas- och quote-token (quote är SOL i detta fall)
        const baseMint = tokenMintPublicKey; // Din token
        const quoteMint = new PublicKey('So11111111111111111111111111111111111111112'); // Wrapped SOL

        // Skapa temporära konton för marknaden
        const marketKeypair = Keypair.generate();
        const requestQueueKeypair = Keypair.generate();
        const eventQueueKeypair = Keypair.generate();
        const bidsKeypair = Keypair.generate();
        const asksKeypair = Keypair.generate();
        const baseVaultKeypair = Keypair.generate();
        const quoteVaultKeypair = Keypair.generate();

        // Minimipris och tick-storlek (justera efter behov)
        const tickSize = 0.01; // Minsta prissteg
        const minBaseOrderSize = 1; // Minsta orderstorlek för bas-token

        // Skapa marknadsinstruktion
        const tx = new Transaction();

        // Beräkna nödvändig lagringsstorlek för marknadskonton
        const marketSpace = Market.getLayout({}).span;
        const requestQueueSpace = 5120 + 12; // Standardstorlek för Serum
        const eventQueueSpace = 262144 + 12;
        const orderbookSpace = 131072 + 12;

        // Lägg till instruktioner för att skapa konton
        tx.add(
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: marketKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(marketSpace),
                space: marketSpace,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'), // OpenBook Program ID (Devnet)
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: requestQueueKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(requestQueueSpace),
                space: requestQueueSpace,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: eventQueueKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(eventQueueSpace),
                space: eventQueueSpace,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: bidsKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(orderbookSpace),
                space: orderbookSpace,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: asksKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(orderbookSpace),
                space: orderbookSpace,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: baseVaultKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(165), // Standardstorlek för vault
                space: 165,
                programId: TOKEN_PROGRAM_ID,
            }),
            SystemProgram.createAccount({
                fromPubkey: ownerPublicKey,
                newAccountPubkey: quoteVaultKeypair.publicKey,
                lamports: await connection.getMinimumBalanceForRentExemption(165),
                space: 165,
                programId: TOKEN_PROGRAM_ID,
            })
        );

        // Skicka transaktionen för att skapa marknadskonton
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = ownerPublicKey;
        await sendAndConfirmTransaction(connection, tx, [
            ownerKeypair,
            marketKeypair,
            requestQueueKeypair,
            eventQueueKeypair,
            bidsKeypair,
            asksKeypair,
            baseVaultKeypair,
            quoteVaultKeypair,
        ]);

        // Skicka en andra transaktion för att initialisera marknaden
        const initMarketTx = new Transaction().add(
            Market.getInstructionToInitMarket({
                market: marketKeypair.publicKey,
                requestQueue: requestQueueKeypair.publicKey,
                eventQueue: eventQueueKeypair.publicKey,
                bids: bidsKeypair.publicKey,
                asks: asksKeypair.publicKey,
                baseVault: baseVaultKeypair.publicKey,
                quoteVault: quoteVaultKeypair.publicKey,
                baseMint,
                quoteMint,
                baseLotSize: minBaseOrderSize,
                quoteLotSize: Math.round(tickSize * LAMPORTS_PER_SOL),
                feeRateBps: 0, // Ingen avgift för denna marknad
                vaultSignerNonce: 0,
                programId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
            })
        );

        initMarketTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        initMarketTx.feePayer = ownerPublicKey;
        await sendAndConfirmTransaction(connection, initMarketTx, [ownerKeypair]);

        // Returnera marketId
        res.json({ success: true, marketId: marketKeypair.publicKey.toBase58(), message: 'Market created successfully' });
    } catch (error) {
        console.error('Error creating market:', error);
        res.json({ success: false, error: error.message });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));