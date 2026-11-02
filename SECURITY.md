# Política de segurança

O radar-cnpj-mcp trabalha com a base pública de CNPJ, que contém dados de pessoas físicas
(como empresários individuais e MEIs). Por isso, tratamos como problema de segurança tanto
vulnerabilidades no código quanto **qualquer forma de expor dados pessoais** que deveriam estar
protegidos, por exemplo:

- CPF aparecendo em algum resultado;
- telefone ou e-mail de MEI exibidos mesmo quando se pediu para ocultá-los;
- uma forma de o servidor MCP ler ou gravar arquivos fora da pasta permitida.

## Como reportar

**Não abra uma issue pública.** Reporte de forma privada pelo
[GitHub Security Advisories](https://github.com/wendersoon/radar-cnpj-mcp/security/advisories/new).

Inclua a versão (`npx radar-cnpj-mcp --version`), o agente de IA ou o comando usado e os passos
para reproduzir. A resposta deve vir em poucos dias.

## Versões com suporte

Somente a versão mais recente publicada no npm recebe correções.
