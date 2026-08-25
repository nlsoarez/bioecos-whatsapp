# Arquitetura técnica

## Decisões

O sistema é um monólito modular. Separar em vários serviços agora criaria custo operacional sem resolver um problema comprovado. Os limites internos permitem extração futura sem acoplamento:

- `http`: validação e exposição de rotas;
- `services/evolution`: tradução do contrato Evolution v2;
- `services/conversation`: orquestração e políticas incontornáveis;
- `services/openai`: Responses API e ciclo de tools;
- `services/tool`: validação de argumentos e autorização de ações;
- `repositories`: persistência e transações;
- `db`: schema, migrações, seed e embeddings.

## Fluxo de mensagem

1. O webhook valida o segredo opcional e normaliza o evento.
2. Eventos que não sejam mensagens recebidas, mensagens próprias, grupos e conteúdo sem texto são ignorados.
3. A mensagem é inserida com `UNIQUE external_message_id`.
4. Duplicidades encerram o processamento sem gerar nova resposta.
5. Se `automation_paused = true`, a IA não é chamada.
6. Políticas determinísticas tratam pedido humano e início de orçamento.
7. Perguntas factuais consultam somente chunks relevantes da base.
8. A Responses API recebe contexto estruturado curto, últimas 12 mensagens e resultados recuperados.
9. Tools são validadas por schema e executadas no servidor.
10. A resposta é enviada pela Evolution e persistida.

## RAG

Cada seção da base vira um chunk. O vetor padrão tem 1.536 dimensões, compatível com `text-embedding-3-small`. A busca usa o maior score entre similaridade cosseno e full-text em português. Se a API de embeddings estiver indisponível, o fallback textual continua funcionando, mas não equivale à homologação semântica final.

O histórico completo nunca é enviado ao modelo. O contexto contém dados estruturados, etapa, tags, resumo quando existente, 12 mensagens recentes e até quatro chunks recuperados.

## Controles de segurança

- allowlist de tags;
- allowlist de etapas;
- conversão bloqueada sem motivo contendo confirmação explícita de matrícula, assinatura ou contratação;
- handoff transacional: etapa, tag, resumo e pausa são atualizados juntos;
- CPF não aparece como pergunta automática no prompt inicial;
- CPF é cifrado em repouso e a API administrativa expõe apenas `has_cpf`;
- logs de auditoria para mensagens, tags, pipeline, dados, notas e handoffs;
- segredos somente por ambiente;
- API administrativa protegida por chave — deve ficar atrás de TLS, firewall e autenticação mais forte em produção.

## Contratos externos

O adaptador mira Evolution API v2. O envio utiliza `POST /message/sendText/{instanceName}`, cabeçalho `apikey` e corpo `{ number, textMessage: { text } }`. A entrada reconhece `MESSAGES_UPSERT` e variações de caixa/pontuação observadas no contrato v2.

A IA utiliza `POST /responses` com custom function tools. Embeddings utilizam `POST /embeddings`. Modelo conversacional e modelo de embedding são variáveis de ambiente.
