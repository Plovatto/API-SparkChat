# Transparência de chaves

Registro verificável e somente de acréscimo (árvore de Merkle no estilo RFC 6962/9162) das chaves de identidade e de assinatura de cada conta. Os clientes só aceitam a chave de um contato se ela estiver provadamente no registro, e cada pessoa audita o que o servidor registrou em nome dela. **Desligado por padrão**: sem `KEY_TRANSPARENCY_ENABLED` nada muda no servidor nem no app.

## O que é registrado

Uma folha por versão das chaves de uma conta: `0x00 || formato || id da folha || versão || chave de identidade || chave de assinatura`, onde o id da folha é `SHA-256("sparkchat:kt:leaf-id:v1:" + id do usuário)`. Nós internos usam `0x01 || esquerda || direita`. O registro nunca contém nicknames, nem listas de usuários. A chave de identidade só é aceita na publicação se tiver 43 caracteres base64url (32 bytes); entradas antigas fora desse formato são ignoradas pelo log, com um aviso, em vez de travar a inicialização.

O id da folha é um hash do id do usuário (um UUID aleatório) e não um HMAC com segredo do servidor de propósito: o cliente precisa recalcular esse id sozinho para saber que a folha é mesmo da conta que ele consulta. Com um HMAC feito pelo servidor, um servidor malicioso poderia apontar uma folha qualquer como sendo "a sua", e a auditoria da própria conta deixaria de funcionar. Como os UUIDs são aleatórios e só quem os conhece consegue calcular o id, o registro não vira um diretório.

## Privacidade

- Não existe nenhuma rota HTTP do registro. Tudo é evento de socket e exige sessão autenticada.
- Não há listagem nem enumeração. Uma prova de inclusão só é devolvida para quem já sabe o id do usuário e as chaves exatas, e só sobre si mesmo e sobre usuários que compartilham alguma sala com quem pede. Para qualquer outro id a resposta é `found: false`, sem consulta nem correção no log.
- `kt:audit` devolve apenas as entradas da própria conta de quem pede.
- `kt:gossip` só é repassado entre contatos que dividem uma sala.
- Todos os eventos têm limite de taxa por usuário e por socket, lotes de no máximo 50 itens e tamanhos máximos para todo campo.

## Eventos de socket (todos autenticados)

| Evento | Resposta | Uso |
| --- | --- | --- |
| `kt:get-head` | `kt:head` | cabeça assinada: tamanho, raiz, instante, assinatura Ed25519. Só o tamanho atual é assinado, nunca tamanhos antigos com horário novo |
| `kt:get-proofs` | `kt:proofs` | prova de inclusão de (usuário, chaves) contra a cabeça atual, para si e para quem divide uma sala |
| `kt:get-consistency` | `kt:consistency` | prova de consistência entre dois tamanhos (`proof: null` se o servidor não conhece o tamanho pedido) |
| `kt:audit` | `kt:audit` | todas as entradas do próprio usuário, com provas |
| `kt:gossip` | `kt:gossip` ao contato | repasse de uma cabeça entre contatos, cifrada de ponta a ponta |

Quando a funcionalidade está ligada, o servidor envia `kt:config` (`{ enabled, logPublicKey }`) logo após a autenticação. Com ela desligada, nenhum desses eventos é registrado e nenhum `kt:config` é enviado.

## Roteiro para ligar em produção

A ordem importa: **API primeiro, depois o app**.

1. Defina `NODE_ENV=production` explicitamente (sem `NODE_ENV` a API se comporta como produção para o registro e exige a chave) e gere a chave de assinatura do registro (uma vez):
   ```bash
   npm run kt:keygen
   ```
   O comando imprime `KT_LOG_SIGNING_KEY=...` e a chave pública correspondente. Guarde a linha `KT_LOG_SIGNING_KEY` em um cofre de segredos (gerenciador de senhas) além do ambiente de hospedagem: **perder essa chave obriga todo mundo a confiar em uma chave nova** (o app oferece o botão "Confiar no novo registro", mas é um evento de segurança). A chave nunca é escrita em logs. Ela precisa ter exatamente 32 bytes em base64url; qualquer outro valor derruba a API na inicialização com a mensagem `KT_LOG_SIGNING_KEY must be 32 random bytes encoded as base64url`. Fora de `NODE_ENV=development` e `test` a variável é obrigatória, e uma chave de desenvolvimento nunca é gerada nem gravada no banco; em desenvolvimento ela é gerada uma vez e guardada na tabela `transparency_meta`.
2. Faça backup do banco como de costume. O registro vive nas tabelas `transparency_leaves`, `transparency_nodes` e `transparency_meta` do mesmo banco, então já entra no backup. **Restaurar um backup antigo faz o registro voltar no tempo**, e os clientes vão mostrar o alerta "O servidor está mostrando registros diferentes". Restaure só em emergência e avise as pessoas.
3. Na hospedagem da API, defina `KEY_TRANSPARENCY_ENABLED=true` e `KT_LOG_SIGNING_KEY=<valor do passo 1>`, e faça o deploy. A migração `0028_key_transparency` cria as três tabelas (só cria, não altera nada existente). Se por algum motivo as tabelas não existirem quando a flag está ligada, a API registra o erro e sobe com a transparência desligada em vez de falhar. O drizzle ignora migrações cujo `when` seja anterior ao da última aplicada: se outra migração com índice 0028 for mesclada antes desta, regere esta com índice e `when` posteriores. Na inicialização a API acrescenta ao registro as chaves de todas as contas existentes (idempotente, em lotes) e ainda corrige sozinha qualquer entrada ausente quando alguém a consulta. O registro em si não bloqueia nada: se ele falhar, a API continua funcionando como antes.
4. Confirme nos logs a linha `Key transparency: enabled`.
5. Publique o app. Ele não precisa de nenhuma variável: o servidor anuncia a chave pública do registro e o app a fixa no primeiro uso. Para fixar a chave no próprio build (mais forte, impede o servidor de trocá-la), defina `VITE_KT_LOG_PUBLIC_KEY` com a chave pública impressa no passo 1.
6. Opcional, recomendado: configure a testemunha (abaixo).

Para desligar de volta, basta remover `KEY_TRANSPARENCY_ENABLED`. Os clientes voltam ao comportamento anterior; o registro fica guardado nas tabelas.

## Testemunha opcional

A testemunha publica apenas a cabeça assinada (`{"v":1,"size":N,"root":"...","issuedAt":...,"signature":"..."}`: tamanho, hash da raiz, instante e assinatura; nada mais) em um lugar que você controla separadamente da API. O app compara essa cabeça com a que ele verificou: mesmo tamanho exige a mesma raiz; uma testemunha mais atrás ou mais à frente exige uma prova de consistência. Se não houver testemunha configurada, tudo continua funcionando com o gossip entre contatos e a auditoria da própria conta.

### Alvo A: repositório do GitHub (recomendado)

1. Crie um repositório seu, por exemplo `sparkchat-witness`, com GitHub Pages ligado (Settings, Pages, branch `main`, pasta raiz). Os dados expostos são só hashes e uma assinatura.
2. Crie um token de acesso de granularidade fina (Settings, Developer settings, Fine-grained tokens) restrito **a esse repositório**, com permissão "Contents: Read and write" e validade de, no máximo, 1 ano. Anote a data de renovação.
3. Na API defina:
   ```env
   KT_WITNESS_GITHUB_REPOSITORY=seu-usuario/sparkchat-witness
   KT_WITNESS_GITHUB_PATH=head.json
   KT_WITNESS_GITHUB_BRANCH=main
   KT_WITNESS_GITHUB_TOKEN=<token>
   KT_WITNESS_INTERVAL_SECONDS=300
   ```
   A API publica a cabeça quando o tamanho do registro muda (no máximo uma vez por intervalo). O token nunca é registrado em logs. Como cada publicação vira um commit, o histórico do repositório funciona como um segundo registro somente de acréscimo.
4. No build do app defina `VITE_KT_WITNESS_URL=https://seu-usuario.github.io/sparkchat-witness/head.json`. A Content-Security-Policy só libera conexão para essa origem quando a variável existe.
5. Para que o operador da API não controle sozinho a testemunha, mantenha a conta do GitHub com autenticação em dois fatores e não compartilhe o token de escrita com mais ninguém além da API.

### Alvo B: webhook

Defina `KT_WITNESS_WEBHOOK_URL` (https obrigatório, sem redirecionamento) e, opcionalmente, `KT_WITNESS_WEBHOOK_TOKEN` (enviado como `Authorization: Bearer`). A API faz `POST` com o mesmo JSON. É problema seu servir esse JSON em uma URL pública com CORS aberto (`Access-Control-Allow-Origin: *`) para o app poder lê-lo via `VITE_KT_WITNESS_URL`.

## O que isto protege e o que não protege

Protege contra um servidor (ou alguém com acesso ao banco) que entrega a um contato uma chave diferente da publicada pela conta sem deixar rastro: toda chave aceita está em um registro assinado, a própria conta é alertada de entradas que não são dela, e visões diferentes do registro são detectadas por consistência, gossip e testemunha.

Não protege contra: um servidor que mente de forma consistente para uma pessoa isolada que nunca troca cabeças com ninguém nem usa a testemunha; comprometimento da chave de assinatura do registro somado ao do servidor; metadados (posição e versão de cada entrada revelam a ordem relativa dos registros).

### Completude da auditoria da própria conta

A omissão de qualquer entrada não é provada. O log é uma árvore de Merkle simples, ordenada por tempo, e não um mapa ordenado por conta: uma prova de inclusão mostra que uma folha existe, nunca que ela é a última nem que não há outras da mesma conta. Um servidor pode, portanto, esconder uma entrada (a mais recente ou qualquer outra) de quem audita a própria conta, e a única garantia de completude seria uma estrutura de mapa ordenado, que esta versão não tem.

Mitigações no cliente, que reduzem o risco sem eliminá-lo:

- Para cada contato o app guarda a maior versão aceita e o hash da folha. Uma versão menor do que a já aceita, ou a mesma versão com chaves diferentes, é recusada.
- Cada pessoa guarda a maior versão e as chaves que a própria auditoria viu, e as envia dentro do gossip cifrado entre contatos. O destinatário compara com o que aceitou desse contato e alerta quando há versão igual com chaves diferentes, ou quando ele aceitou uma versão mais nova que a pessoa, ao auditar depois disso, nunca viu.
- A testemunha e o gossip de cabeças detectam visões diferentes do log inteiro.

### Falhas do servidor contra o cliente

Erros e silêncio do servidor nos eventos `kt:*` não são tratados como "log indisponível". Com o app conectado, uma chave que não pôde ser verificada fica pendente (não utilizável) e a verificação é tentada de novo; só um socket realmente desconectado, em uma conta que nunca usou o registro, deixa a chave passar sem prova. Se um evento continua falhando enquanto os outros respondem, o app alerta. Contas que já usaram o registro, ou cujo build fixa a chave do log, recebem um alerta de rebaixamento quando o servidor deixa de enviar `kt:config` ou o envia desligado; com a chave fixada no build o app ainda recusa chaves novas ou alteradas de contatos.

Também não impede o primeiro contato (confiança no primeiro uso) se o servidor já estava comprometido quando o app fixou a chave do registro, exceto com `VITE_KT_LOG_PUBLIC_KEY`.
