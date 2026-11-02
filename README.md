<div align="center">

# 📡 radar-cnpj-mcp

**Encontre empresas por atividade e região na base pública de CNPJ da Receita Federal,
direto do seu agente de IA ou do terminal.**

[![CI](https://github.com/wendersoon/radar-cnpj-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wendersoon/radar-cnpj-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)](LICENSE)

![Um agente de IA usando o radar-cnpj-mcp para consultar oficinas mecânicas em Campinas](assets/agente.gif)

</div>

## Por que

Você quer entender **quais empresas existem em um setor ou região**: quantas oficinas há em
Campinas, quais academias abriram este ano em São Paulo, onde se concentram as clínicas
odontológicas do estado.

A Receita Federal publica o cadastro de **mais de 70 milhões de estabelecimentos**, mas em
arquivos brutos de vários GB. O radar-cnpj-mcp transforma isso numa base local, consultada
em milissegundos, que o seu agente de IA entende.

- ⚡ **Instantâneo**: buscas em milissegundos, mesmo no Brasil inteiro
- 🔒 **Local e gratuito**: os dados ficam na sua máquina, sem mensalidade nem limite de resultados
- 🧠 **Feito para IA**: o agente traduz "oficina mecânica" para o CNAE certo e aplica os filtros
- 🇧🇷 **Pensado para o Brasil**: busca sem acentos, MEI separado de microempresa, CSV pronto para o Excel

## Pergunte do seu jeito

> **Você:** Quantas oficinas mecânicas ativas existem em Campinas?
>
> **Claude:** 2.301 estabelecimentos com a atividade principal 4520-0/01 (manutenção e
> reparação mecânica de veículos). Desses, 1.407 são MEIs e 783 são microempresas.

Outras ideias:

- _"Liste academias abertas desde 2025 em Santo André, sem MEI, com telefone."_
- _"Em quais cidades de SP há mais clínicas odontológicas?"_
- _"Exporte para CSV os restaurantes do bairro Pinheiros."_
- _"Como é a economia de Campinas?"_
- _"Onde há mais clínicas odontológicas: Campinas, Santos ou Sorocaba?"_

## Como usar

Requer [Node.js](https://nodejs.org) 20 ou superior.

**1. Baixe os dados da Receita Federal.** O comando busca os arquivos do mês mais recente direto
da Receita e monta a base na sua máquina, só com as UFs pedidas. O projeto não hospeda nem
redistribui os dados.

```sh
npx -y radar-cnpj-mcp baixar --ufs SP,MG
```

São cerca de 7 GB de download, mesmo para uma só UF, porque a Receita não separa os arquivos por
estado. Reserve cerca de 20 GB livres durante o processo; ao final, os arquivos temporários são
apagados e fica só a base (1,9 GB para SP e AC). Com SP e AC, levou cerca de 33 minutos, dos quais
18 de download; o tempo depende da sua conexão e da máquina. Para guardar os ZIPs, use
`--manter-arquivos <pasta>`. Para o Brasil inteiro, troque `--ufs` por `--todas`, o que exige mais
tempo e espaço.

<details>
<summary><b>Prefere baixar pelo navegador?</b></summary>

1. Abra a [pasta do CNPJ na Receita Federal](https://arquivos.receitafederal.gov.br/index.php/s/gn672Ad4CF8N6TK?dir=/Dados/Cadastros/CNPJ)
   e entre na pasta do mês mais recente (por exemplo, `2026-10`).
2. Baixe, para uma mesma pasta, os arquivos `Estabelecimentos*.zip`, `Empresas*.zip`,
   `Simples.zip`, `Cnaes.zip` e `Municipios.zip`. Não é preciso descompactar. Os demais, como
   `Socios*.zip`, não são usados.
3. Importe a pasta:

```sh
npx -y radar-cnpj-mcp importar ~/Downloads/2026-10 --ufs SP,MG
```

</details>

**2. Conecte ao seu agente de IA.**

<details open>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add radar-cnpj -- npx -y radar-cnpj-mcp
```

</details>

<details>
<summary><b>Claude Desktop, Cursor, VS Code e outros</b></summary>

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

</details>

Pronto: peça ao agente o que procura. Para atualizar a base todo mês, rode o `baixar` de novo.

Também dá para pedir ao agente: _"Baixe os dados da Receita para SP e MG."_ Ele confirma com você
e o download continua em segundo plano, mesmo se você fechar o agente. Cada download substitui a
base atual, então inclua todas as UFs que quiser manter.

### Instalação via npm

Se preferir instalar em vez de usar o `npx`:

```sh
npm install -g radar-cnpj-mcp
radar-cnpj-mcp baixar --ufs SP,MG
```

E configure o agente com o comando instalado:

```sh
claude mcp add radar-cnpj -- radar-cnpj-mcp
```

```json
{
  "mcpServers": {
    "radar-cnpj": { "command": "radar-cnpj-mcp" }
  }
}
```

Para atualizar a ferramenta: `npm update -g radar-cnpj-mcp`.

## O que o agente ganha

| Ferramenta           | O que faz                                                                    |
| -------------------- | ---------------------------------------------------------------------------- |
| `buscar_empresas`    | Lista empresas com CNPJ, razão social, atividade, endereço e contatos        |
| `contar_empresas`    | Conta empresas, agrupando por UF, município, bairro, CNAE, porte, MEI ou ano |
| `buscar_cnae`        | Descobre o código CNAE a partir da descrição da atividade                    |
| `buscar_municipio`   | Encontra municípios pelo nome                                                |
| `detalhar_empresa`   | Mostra todos os dados de um CNPJ                                             |
| `exportar_csv`       | Gera uma planilha CSV pronta para o Excel                                    |
| `status_base`        | Informa o mês de referência e as UFs importadas                              |
| `perfil_municipio`   | Resume a economia de um município: setores, porte, MEIs e aberturas recentes |
| `comparar_regioes`   | Compara até 5 municípios ou UFs, no mesmo setor ou em todos                  |
| `baixar_dados`       | Baixa os dados da Receita em segundo plano, a pedido do usuário              |
| `andamento_download` | Mostra a etapa do download iniciado pelo agente                              |

**Filtros:** CNAE (exato ou por prefixo, principal ou secundário), UF, município, bairro,
CEP, situação cadastral, data de abertura, porte, MEI, matriz/filial, capital social e
existência de telefone ou e-mail.

**Atalhos (prompts):** `consultar_empresas`, `panorama_setor` e `empresas_recentes`. No Claude
Code, viram comandos como `/radar-cnpj:consultar_empresas`.

**Resources:** `radar://status`, `radar://cnaes`, `radar://municipios/{uf}` e
`radar://empresa/{cnpj}`, para anexar à conversa.

## No terminal

![Contagem de empresas e oficinas mecânicas em São Paulo pelo terminal](assets/terminal.gif)

```sh
npx radar-cnpj-mcp contar --cnae 4520-0/01 --uf SP --agrupar municipio
npx radar-cnpj-mcp buscar --cnae 4520-0/01 --municipio Campinas --sem-mei --limite 20
npx radar-cnpj-mcp buscar --cnae 4520 --municipio Campinas --csv oficinas.csv
npx radar-cnpj-mcp status
npx radar-cnpj-mcp --help
```

## Privacidade

Os dados vêm direto da Receita Federal e ficam na sua máquina. Se o seu agente de IA roda na
nuvem, os resultados das consultas são enviados ao provedor dele. Telefone e e-mail de MEIs
costumam ser os da própria pessoa física: para ocultá-los, peça ao agente ou use
`--ocultar-contatos-mei` no terminal. Ao usar os dados para contatar empresas, respeite a LGPD:
faça ofertas ligadas à atividade delas e ofereça uma forma de não serem mais contatadas.

## Desenvolvimento

```sh
npm install
npm test           # testes
npm run lint       # Biome
npm run typecheck
npm run build
```

## Contribuindo

Contribuições são bem-vindas! Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE). Dados: [Receita Federal do Brasil – Dados Abertos do
CNPJ](https://arquivos.receitafederal.gov.br/).

## LGPD

O radar-cnpj-mcp foi feito com a LGPD em mente:

- não hospeda nem redistribui dados: cada usuário baixa a base pública de CNPJ da Receita
  Federal para a própria máquina;
- não importa os dados de sócios;
- remove na importação os números em formato de CPF, o que reduz mas não garante a ausência de
  todos, já que os campos da Receita são texto livre.

A razão social de MEIs e empresários individuais pode conter o nome da pessoa, e os contatos de
MEIs costumam ser os dela, como constam na base da Receita. Cada usuário é responsável por usar os dados de acordo com a LGPD. Este aviso
não é um parecer jurídico.
