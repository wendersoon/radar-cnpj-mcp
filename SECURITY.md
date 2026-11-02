# Política de segurança

O radar-cnpj-mcp é uma interface local para consultar a base pública de CNPJ da Receita Federal.
O projeto não hospeda dados nem recebe as consultas de quem usa. Esta política cobre
vulnerabilidades no código e no pacote publicado, por exemplo:

- o servidor MCP ler ou gravar arquivos fora da pasta permitida;
- um parâmetro de ferramenta conseguir alterar uma consulta SQL ou executar comandos;
- uma dependência ou o pacote no npm comprometidos.

## O que esta política não cobre

- **Conteúdo dos dados e pedidos de alteração ou remoção:** os dados são publicados pela Receita
  Federal e ficam na máquina de quem os baixa, então não há nada hospedado pelo projeto para
  remover. Na origem, a solicitação precisa ser feita à própria Receita Federal.
- **Falhas na remoção de CPFs ou na opção de ocultar contatos de MEI:** são bugs comuns. Abra uma
  [issue](https://github.com/wendersoon/radar-cnpj-mcp/issues/new/choose) sem incluir o dado.

## Como reportar

**Não abra uma issue pública para vulnerabilidades.** Reporte de forma privada pelo
[GitHub Security Advisories](https://github.com/wendersoon/radar-cnpj-mcp/security/advisories/new).

Inclua a versão (`npx radar-cnpj-mcp --version`), o agente de IA ou o comando usado e os passos
para reproduzir. A resposta deve vir em poucos dias.

## Versões com suporte

Somente a versão mais recente publicada no npm recebe correções.
