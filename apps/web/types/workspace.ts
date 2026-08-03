export type WorkspaceGoalType = 'revenue' | 'roi'
export type WorkspaceStatus = 'exploring' | 'validating' | 'ready_to_act'
export type ConfidenceLevel = 'low' | 'med' | 'high'

export interface WorkspaceContext {
  decisionTitle: string
  goalType: WorkspaceGoalType
  primarySuccessMetric: string
  status: WorkspaceStatus
  confidence: ConfidenceLevel
}

export interface DecisionSummary {
  stance: string
  rationale: string
  changeTriggers: string[]
}

export interface EvidenceTimelineStep {
  id: string
  stepType: 'hypothesis' | 'data_pull' | 'finding' | 'refinement'
  title: string
  content: string
  createdAt: string
  superseded?: boolean
}

export interface EvidenceCard {
  id: string
  question: string
  claim: string
  evidence: string[]
  dataSource: string[]
  status: 'active' | 'superseded' | 'discarded'
}

export interface Recommendation {
  proposedAction: string
  supportingEvidence: string[]
  risks: string[]
  confidence: ConfidenceLevel
  nextExperiment: string
}

export interface DecisionWorkspace {
  id: string
  title: string
  decisionQuestion: string
  context: WorkspaceContext
  summary: DecisionSummary
  timeline: EvidenceTimelineStep[]
  cards: EvidenceCard[]
  recommendation: Recommendation
  createdAt: string
  updatedAt: string
}
