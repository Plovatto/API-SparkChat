# Como contribuir

## Reportando problemas

Abra uma [issue](https://github.com/Plovatto/API-SparkChat/issues) descrevendo o problema, os passos para reproduzir e o comportamento esperado. Falhas de segurança devem ser reportadas pela [política de segurança](SECURITY.md).

## Enviando alterações

1. Crie uma branch a partir da `main` com o prefixo do tipo da alteração: `feature/`, `fix/`, `chore/` ou `docs/`.
2. Use commits no padrão [gitmoji](https://gitmoji.dev/) com [Conventional Commits](https://www.conventionalcommits.org/), por exemplo `:bug: fix: corrige a prévia de links`.
3. Funcionalidades novas e correções devem vir acompanhadas de testes.
4. Antes de abrir o pull request, rode `npm run lint`, `npm run typecheck` e `npm test`.
5. Abra o pull request para a `main` descrevendo o que foi feito, os detalhes e como foi testado.
