/**
 * Os agentes especializados. Cada um enxerga SÓ as ferramentas da sua lista —
 * nenhum herda as permissões de outro. O "assistente" é quem conversa com
 * você; os demais são usados nas etapas de um plano e nas tarefas de fundo.
 * Nenhum agente pode criar outros agentes ou tarefas (sem recursão).
 */
export const AGENTES = {
  assistente: {
    nome: 'Assistente',
    descricao: 'conversa e pedidos do dia a dia',
    ferramentas: ['tempo.agora', 'memoria.buscar', 'memoria.salvar', 'tarefas.listar', 'tarefas.criar', 'tarefas.concluir', 'lembretes.criar', 'lembretes.listar', 'clima.consultar', 'noticias.buscar', 'web.buscar', 'web.ler', 'agenda.listar', 'agenda.horarios_ocupados', 'agenda.criar', 'email.buscar', 'pc.abrir', 'pc.sistema'],
  },
  pesquisa: {
    nome: 'Pesquisa',
    descricao: 'pesquisa na internet, compara fontes e resume',
    ferramentas: ['tempo.agora', 'web.buscar', 'web.ler', 'noticias.buscar'],
  },
  organizacao: {
    nome: 'Organização',
    descricao: 'tarefas, lembretes e rotinas',
    ferramentas: ['tempo.agora', 'tarefas.listar', 'tarefas.criar', 'tarefas.concluir', 'tarefas.excluir', 'lembretes.criar', 'lembretes.listar', 'lembretes.cancelar', 'rotinas.listar', 'rotinas.criar'],
  },
  memoria: {
    nome: 'Memória',
    descricao: 'guarda, procura, corrige e apaga memórias',
    ferramentas: ['memoria.buscar', 'memoria.salvar', 'memoria.atualizar', 'memoria.excluir'],
  },
  agenda: {
    nome: 'Agenda',
    descricao: 'compromissos, horários livres e conflitos',
    ferramentas: ['tempo.agora', 'agenda.listar', 'agenda.horarios_ocupados', 'agenda.criar', 'agenda.alterar', 'agenda.cancelar'],
  },
  comunicacao: {
    nome: 'Comunicação',
    descricao: 'lê e-mails, resume, prepara respostas (enviar exige confirmação)',
    ferramentas: ['email.buscar', 'email.ler', 'email.rascunho', 'email.enviar', 'memoria.buscar'],
  },
  documentos: {
    nome: 'Documentos',
    descricao: 'encontra e lê documentos',
    ferramentas: ['drive.buscar', 'web.ler', 'memoria.buscar', 'pc.listar_arquivos'],
  },
  monitoramento: {
    nome: 'Monitoramento',
    descricao: 'confere notícias, clima, e-mails e agenda para avisar o que importa',
    ferramentas: ['tempo.agora', 'noticias.buscar', 'clima.consultar', 'email.buscar', 'agenda.listar', 'tarefas.listar', 'lembretes.listar'],
  },
  planejamento: {
    nome: 'Planejamento',
    descricao: 'organiza prioridades e planos a partir da agenda, tarefas e memória',
    ferramentas: ['tempo.agora', 'tarefas.listar', 'agenda.listar', 'agenda.horarios_ocupados', 'memoria.buscar'],
  },
  computador: {
    nome: 'Computador',
    descricao: 'abre programas, sites e pastas e controla o PC pareado',
    ferramentas: ['pc.abrir', 'pc.sistema', 'pc.listar_arquivos'],
  },
}

/** Limites por pedido: etapas do plano, rodadas de ferramenta, tempo. */
export const LIMITES = {
  maxEtapasPlano: 5,
  maxRodadasFerramenta: 6,
  maxMsPedido: 120000,
  maxMsTarefaFundo: 10 * 60000,
  maxProfundidade: 1,
}
