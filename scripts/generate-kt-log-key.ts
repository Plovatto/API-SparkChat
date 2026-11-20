import { generateSigningSeed, parseSigningSeed, TreeHeadSigner } from '../src/modules/transparency/transparency.signer.js';

const seed = generateSigningSeed();

console.log('Cole esta linha no seu .env (guarde uma copia em um cofre de segredos):');
console.log(`KT_LOG_SIGNING_KEY=${seed}`);
console.log('');
console.log('Chave publica do log (anunciada aos clientes; apenas para conferencia):');
console.log(new TreeHeadSigner(parseSigningSeed(seed)).publicKey);
