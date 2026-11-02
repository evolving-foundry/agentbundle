/** Shape transforms applied to a compiled workflow DSL before import. */

export interface DifyModelBinding {
  readonly provider: string
  readonly model: string
}

export interface DifyHumanInputBinding {
  readonly webappDelivery: boolean
  readonly defaultAction: string
  readonly actionTitle: string
}

type NodeData = Record<string, unknown>

function graphNodes(doc: Record<string, unknown>): NodeData[] {
  const workflow = doc['workflow'] as Record<string, unknown> | undefined
  const graph = workflow?.['graph'] as Record<string, unknown> | undefined
  const nodes = graph?.['nodes']
  if (!Array.isArray(nodes)) return []
  return nodes.map(node => ((node as Record<string, unknown>)['data'] ?? {}) as NodeData)
}

/**
 * G9: sop-compiler emits if-else `cases` as a mapping (handle → branch) while
 * the dify runtime requires a list of {case_id, logical_operator, conditions}.
 * Small graphs import fine (import validation is looser than node runtime
 * validation) and only fail at execution, so normalize unconditionally.
 */
export function normalizeIfElseCases(doc: Record<string, unknown>): void {
  for (const data of graphNodes(doc)) {
    if (data['type'] !== 'if-else') continue
    const cases = data['cases']
    if (cases !== null && typeof cases === 'object' && !Array.isArray(cases)) {
      data['cases'] = Object.entries(cases as Record<string, Record<string, unknown>>).map(
        ([handle, branch]) => ({
          case_id: handle,
          logical_operator: 'and',
          conditions: branch['conditions'] ?? [],
        }),
      )
    }
  }
}

export function applyModelBinding(doc: Record<string, unknown>, model: DifyModelBinding): void {
  for (const data of graphNodes(doc)) {
    if (data['type'] !== 'llm') continue
    data['model'] = { provider: model.provider, name: model.model, mode: 'chat', completion_params: {} }
    data['context'] = data['context'] ?? { enabled: false, variable_selector: [] }
  }
}

export function normalizeHumanInputFields(doc: Record<string, unknown>): void {
  // dify 1.17.x workflow canvas requires these fields on human-input nodes:
  // getOutputVars reads payload.inputs and checkValid reads the rest — missing
  // fields crash the editor render ("unexpected error" boundary) even though
  // import validation and runtime execution tolerate their absence.
  for (const data of graphNodes(doc)) {
    if (data['type'] !== 'human-input') continue
    if (!Array.isArray(data['inputs'])) data['inputs'] = []
    if (typeof data['form_content'] !== 'string') data['form_content'] = ''
    if (typeof data['timeout'] !== 'number') data['timeout'] = 3
    if (typeof data['timeout_unit'] !== 'string') data['timeout_unit'] = 'day'
  }
}

export function applyHumanInputBinding(doc: Record<string, unknown>, binding: DifyHumanInputBinding): void {
  normalizeHumanInputFields(doc)
  for (const data of graphNodes(doc)) {
    if (data['type'] !== 'human-input') continue
    if (binding.webappDelivery) {
      data['delivery_methods'] = [{ type: 'webapp', enabled: true }]
    }
    const actions = data['user_actions']
    if (binding.defaultAction !== '' && (!Array.isArray(actions) || actions.length === 0)) {
      data['user_actions'] = [{ id: binding.defaultAction, title: binding.actionTitle, button_style: 'primary' }]
    }
  }
}
