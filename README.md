# radar-cnpj-mcp

Encontre empresas por **atividade (CNAE)** e **região** na base pública de CNPJ da
Receita Federal, direto do seu assistente de IA (Claude, Cursor, VS Code…) ou do terminal.

> "Liste as oficinas mecânicas ativas em Campinas e Sumaré abertas nos últimos 2 anos, sem MEI."

O radar-cnpj-mcp importa os dados abertos da Receita para um banco local, então as
buscas são instantâneas, gratuitas e sem limite de resultados.

## Instalação

Requer Node.js 20 ou superior.

### 1. Baixe os dados da Receita

Acesse [arquivos.receitafederal.gov.br](https://arquivos.receitafederal.gov.br/), abra
**Dados > Cadastros > CNPJ**, entre na pasta do mês mais recente (ex.: `2026-10`) e baixe
para uma pasta local os arquivos `Estabelecimentos*.zip`, `Empresas*.zip`, `Simples.zip`,
`Cnaes.zip` e `Municipios.zip`.

### 2. Importe as UFs que interessam

```sh
npx -y radar-cnpj-mcp importar ~/Downloads/2026-10 --ufs SP,MG
```

Importar só as UFs do seu território deixa a base bem menor e mais rápida.

### 3. Configure o seu assistente

```json
{
  "mcpServers": {
    "radar-cnpj": {
      "command": "npx",
      "args": ["-y", "radar-cnpj-mcp"]
    }
  }
}
```

No Claude Code: `claude mcp add radar-cnpj -- npx -y radar-cnpj-mcp`.

## Ferramentas

| Ferramenta         | O que faz                                                               |
| ------------------ | ----------------------------------------------------------------------- |
| `buscar_empresas`  | Lista empresas com CNPJ, razão social, atividade, endereço e contatos   |
| `contar_empresas`  | Conta empresas, agrupando por UF, município, bairro, CNAE, porte ou ano |
| `buscar_cnae`      | Descobre o código CNAE a partir da descrição da atividade               |
| `buscar_municipio` | Encontra municípios pelo nome                                           |
| `detalhar_empresa` | Mostra todos os dados de um CNPJ                                        |
| `exportar_csv`     | Gera uma planilha CSV pronta para o Excel                               |
| `status_base`      | Informa o mês de referência e as UFs importadas                         |

Filtros disponíveis: CNAE (exato ou por prefixo, principal ou secundário), UF, município,
bairro, CEP, situação cadastral, data de abertura, porte, MEI, matriz/filial, capital
social e existência de telefone ou e-mail.

## Terminal

```sh
npx radar-cnpj-mcp buscar --cnae 4520-0/01 --uf SP --municipio Campinas --limite 20
npx radar-cnpj-mcp buscar --cnae 4520 --municipio Campinas --csv oficinas.csv
npx radar-cnpj-mcp status
```

## Privacidade

Os dados são públicos e ficam apenas na sua máquina. Por padrão, o **telefone e o e-mail
de MEIs ficam ocultos**, porque costumam ser os da própria pessoa física; use
`incluir_contatos_mei` se tiver uma base legal para isso. Ao usar os dados para
prospecção, respeite a LGPD: aborde empresas com ofertas relevantes à atividade delas e
ofereça uma forma de não ser mais contatado.

## Desenvolvimento

```sh
npm install
npm test          # testes
npm run lint      # Biome
npm run typecheck
npm run build
```

## Licença

[MIT](LICENSE). Os dados são da Receita Federal, publicados como dados abertos.
