# Como contribuir

Obrigado pelo interesse! Relatos de bugs, ideias e pull requests são bem-vindos.

## Antes de começar

- **Bugs e ideias:** abra uma [issue](https://github.com/wendersoon/radar-cnpj-mcp/issues/new/choose).
- **Problemas de segurança ou de privacidade** (por exemplo, um dado pessoal exposto): não abra
  issue pública; veja o [SECURITY.md](SECURITY.md).
- **Mudanças grandes:** abra uma issue antes, para combinarmos a abordagem.
- Procurando por onde começar? Veja as issues marcadas com
  [`good first issue`](https://github.com/wendersoon/radar-cnpj-mcp/labels/good%20first%20issue).

## Ambiente

Requer Node.js 20 ou superior.

```sh
git clone https://github.com/wendersoon/radar-cnpj-mcp.git
cd radar-cnpj-mcp
npm install
npm test           # testes
npm run lint       # Biome
npm run typecheck
npm run build
```

Os testes não precisam da base real da Receita: eles geram arquivos no mesmo formato, com
empresas fictícias. Para testar à mão com dados reais, importe uma UF pequena (ex.: `--ufs AC`)
num banco separado:

```sh
RADAR_CNPJ_DB=/tmp/teste.duckdb node dist/cli.js importar <pasta-do-mes> --ufs AC
RADAR_CNPJ_DB=/tmp/teste.duckdb node dist/cli.js contar --agrupar municipio
```

## Organização do código

| Pasta        | Responsabilidade                                             |
| ------------ | ------------------------------------------------------------ |
| `src/domain` | Filtros (validados com zod), códigos da Receita e formatação |
| `src/data`   | Importação para o DuckDB, consultas e repositório            |
| `src/mcp`    | Ferramentas, prompts e resources do servidor MCP             |
| `src/cli.ts` | Comandos de terminal                                         |
| `test`       | Testes com Vitest                                            |

## Pull requests

- Mantenha o PR focado e com testes. Mudanças nas ferramentas MCP devem ser cobertas em
  `test/server.test.ts`.
- Use consultas parametrizadas: nenhum valor vindo do usuário entra no texto do SQL.
- **Privacidade:** não exponha dados de pessoas físicas. O projeto não hospeda nem redistribui
  a base, os dados de sócios não são importados e o CPF que a Receita acrescenta ao nome de
  empresários individuais é removido. Recursos novos devem seguir essa linha.
- O título do PR segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/), em
  inglês e curto: `feat(cli): add --format json to contar`, `fix(data): ...`.
- O CI (lint, tipos e testes em Linux, macOS e Windows) precisa passar. Os PRs entram por
  squash, usando o título como mensagem do commit.

## Releases

Ao criar uma tag `vX.Y.Z`, o GitHub Actions roda os testes, publica no npm com
[provenance](https://docs.npmjs.com/generating-provenance-statements) e cria o release no GitHub.

Ao contribuir, você concorda que sua contribuição será licenciada sob a [licença MIT](LICENSE)
e em seguir o [Código de Conduta](CODE_OF_CONDUCT.md).
