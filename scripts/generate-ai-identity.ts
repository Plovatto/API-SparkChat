import sodium from 'libsodium-wrappers-sumo';

async function main(): Promise<void> {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();

  console.log('Cole esta linha no seu .env:');
  console.log(`AI_ASSISTANT_PRIVATE_KEY=${sodium.to_base64(keyPair.privateKey)}`);
  console.log('');
  console.log('Chave pública correspondente (apenas para conferência, não precisa salvar):');
  console.log(sodium.to_base64(keyPair.publicKey));
}

void main();
