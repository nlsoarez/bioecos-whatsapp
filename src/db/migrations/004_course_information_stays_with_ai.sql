-- Retoma somente conversas que foram pausadas pelos gatilhos automáticos antigos.
-- Handoffs financeiros e pedidos explícitos de atendimento humano permanecem intactos.
UPDATE leads l
SET pipeline_stage_id = ps.id, updated_at = now()
FROM conversations cv
JOIN contacts c ON c.id = cv.contact_id
JOIN pipeline_stages ps ON ps.project_id = c.project_id AND ps.name = 'Interesse identificado'
WHERE l.contact_id = c.id
  AND cv.status = 'open'
  AND cv.workflow_state = 'awaiting_coordinator'
  AND cv.handoff_reason IN (
    'Informação importante não encontrada nos documentos oficiais',
    'IA indisponível; atendimento seguro transferido'
  );

UPDATE conversations
SET automation_paused = false,
    workflow_state = 'ai_attending',
    current_owner = 'ai',
    handoff_reason = null,
    coordinator_notification_status = 'not_required'
WHERE workflow_state = 'awaiting_coordinator'
  AND status = 'open'
  AND handoff_reason IN (
    'Informação importante não encontrada nos documentos oficiais',
    'IA indisponível; atendimento seguro transferido'
  );
