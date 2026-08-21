import type {
  CandidateRisk,
  CoverageSnapshot,
  CoverageTerminalGap,
  CoverageTerminalReason,
  ExplorationCandidate,
} from '../core/types.js';

type CandidateState = {
  id: string;
  label: string;
  risk: CandidateRisk;
  allowed: boolean;
  exercised: boolean;
  observedStateId?: string;
  terminalReason?: CoverageTerminalReason;
  terminalDetail?: string;
};

type PageState = {
  url: string;
  depth: number;
  visited: boolean;
  visits: number;
  errors: number;
  candidates: Map<string, CandidateState>;
};

const INELIGIBLE_TERMINAL_REASONS = new Set<CoverageTerminalReason>([
  'blocked-by-risk-policy',
  'duplicate-state-action',
  'stale-after-state-change',
  'not-visible',
  'auth-gated',
  'unsupported-control',
  'navigation-duplicate',
]);

const REOPEN_ON_STATE_CHANGE = new Set<CoverageTerminalReason>([
  'duplicate-state-action',
  'stale-after-state-change',
  'not-visible',
  'pointer-intercepted',
]);

function candidateEligible(candidate: CandidateState): boolean {
  if (!candidate.allowed) return false;
  return !candidate.terminalReason || !INELIGIBLE_TERMINAL_REASONS.has(candidate.terminalReason);
}

export class CoverageGraph {
  private readonly pages = new Map<string, PageState>();

  discoverPage(url: string, depth: number): void {
    const current = this.pages.get(url);
    if (current) {
      current.depth = Math.min(current.depth, depth);
      return;
    }
    this.pages.set(url, { url, depth, visited: false, visits: 0, errors: 0, candidates: new Map() });
  }

  visitPage(url: string, depth = 0): void {
    this.discoverPage(url, depth);
    const page = this.pages.get(url)!;
    page.visited = true;
    page.visits += 1;
  }

  discoverCandidate(
    url: string,
    candidate: ExplorationCandidate,
    risk: CandidateRisk,
    allowed: boolean,
    stateId?: string,
  ): void {
    let page = this.pages.get(url);
    if (!page) {
      this.discoverPage(url, 0);
      page = this.pages.get(url)!;
    }
    const current = page.candidates.get(candidate.id);
    if (current) {
      const stateChanged = stateId === undefined || current.observedStateId === undefined || current.observedStateId !== stateId;
      current.risk = risk;
      current.allowed = allowed;
      current.label = candidate.label || candidate.kind;
      if (stateId !== undefined) current.observedStateId = stateId;
      if (current.exercised) return;
      if (!allowed) {
        current.terminalReason = 'blocked-by-risk-policy';
        current.terminalDetail = risk;
      } else if (current.terminalReason && stateChanged && REOPEN_ON_STATE_CHANGE.has(current.terminalReason)) {
        // Only state-dependent/transient reasons reopen automatically. A repeated
        // observation in the same structural state must not erase a meaningful
        // pointer/stale terminal reason and artificially create an unexplained gap.
        current.terminalReason = undefined;
        current.terminalDetail = undefined;
      }
      return;
    }
    page.candidates.set(candidate.id, {
      id: candidate.id,
      label: candidate.label || candidate.kind,
      risk,
      allowed,
      exercised: false,
      observedStateId: stateId,
      ...(!allowed ? { terminalReason: 'blocked-by-risk-policy' as const, terminalDetail: risk } : {}),
    });
  }

  markCandidateExercised(url: string, candidateId: string): void {
    const candidate = this.pages.get(url)?.candidates.get(candidateId);
    if (candidate) {
      candidate.exercised = true;
      candidate.terminalReason = undefined;
      candidate.terminalDetail = undefined;
    }
  }

  markCandidateTerminal(
    url: string,
    candidateId: string,
    reason: CoverageTerminalReason,
    detail?: string,
  ): void {
    const candidate = this.pages.get(url)?.candidates.get(candidateId);
    if (!candidate || candidate.exercised) return;
    candidate.terminalReason = reason;
    candidate.terminalDetail = detail;
  }

  candidateTerminalReason(url: string, candidateId: string): CoverageTerminalReason | undefined {
    return this.pages.get(url)?.candidates.get(candidateId)?.terminalReason;
  }

  markRemainingEligibleTerminal(reason: CoverageTerminalReason, url?: string, detail?: string): void {
    const pages = url ? [this.pages.get(url)].filter((page): page is PageState => Boolean(page)) : [...this.pages.values()];
    for (const page of pages) {
      for (const candidate of page.candidates.values()) {
        if (candidate.allowed && !candidate.exercised && candidateEligible(candidate)) {
          candidate.terminalReason = reason;
          candidate.terminalDetail = detail;
        }
      }
    }
  }

  markPageError(url: string): void {
    let page = this.pages.get(url);
    if (!page) {
      this.discoverPage(url, 0);
      page = this.pages.get(url)!;
    }
    page.errors += 1;
  }

  hasVisited(url: string): boolean {
    return this.pages.get(url)?.visited ?? false;
  }

  wasCandidateExercised(url: string, candidateId: string): boolean {
    return this.pages.get(url)?.candidates.get(candidateId)?.exercised ?? false;
  }

  snapshot(): CoverageSnapshot {
    const pages = [...this.pages.values()];
    const visitedPages = pages.filter((page) => page.visited).length;
    const pageCoverageRatio = pages.length === 0 ? 0 : visitedPages / pages.length;
    const allCandidates = pages.flatMap((page) => [...page.candidates.values()].map((candidate) => ({ page, candidate })));
    const allowedCandidates = allCandidates.filter(({ candidate }) => candidate.allowed);
    const rawExercised = allowedCandidates.filter(({ candidate }) => candidate.exercised).length;
    const rawCoverageRatio = allowedCandidates.length === 0 ? (visitedPages > 0 ? 1 : 0) : rawExercised / allowedCandidates.length;

    const eligibleCandidates = allCandidates.filter(({ candidate }) => candidate.exercised || candidateEligible(candidate));
    const exercisedEligible = eligibleCandidates.filter(({ candidate }) => candidate.exercised).length;
    const eligibleCoverageRatio = eligibleCandidates.length === 0 ? (visitedPages > 0 ? 1 : 0) : exercisedEligible / eligibleCandidates.length;

    let explainedEligibleGaps = 0;
    let unexplainedEligibleGaps = 0;
    const terminalGaps: CoverageTerminalGap[] = [];
    const gapReasonCounts: Partial<Record<CoverageTerminalReason, number>> = {};

    for (const { page, candidate } of allCandidates) {
      if (candidate.exercised) continue;
      const eligible = candidateEligible(candidate);
      if (candidate.terminalReason) {
        gapReasonCounts[candidate.terminalReason] = (gapReasonCounts[candidate.terminalReason] ?? 0) + 1;
        terminalGaps.push({
          scope: 'interaction',
          url: page.url,
          candidateId: candidate.id,
          label: candidate.label,
          reason: candidate.terminalReason,
          ...(candidate.terminalDetail ? { detail: candidate.terminalDetail } : {}),
          eligible,
          explained: true,
        });
        if (eligible) explainedEligibleGaps += 1;
      } else if (eligible) {
        unexplainedEligibleGaps += 1;
      }
    }

    // Preserve Beta.9 score semantics and expose the Beta.10 eligible percentage
    // additively. A caller cannot inflate the legacy score merely by marking a
    // candidate ineligible.
    const score = Math.round((pageCoverageRatio * 0.55 + rawCoverageRatio * 0.45) * 100);

    const gaps: string[] = [];
    for (const page of pages) {
      if (!page.visited) gaps.push(`Unvisited page: ${page.url}`);
      for (const candidate of page.candidates.values()) {
        if (candidate.exercised) continue;
        if (candidate.terminalReason) {
          gaps.push(`${candidateEligible(candidate) ? 'Eligible' : 'Ineligible'} interaction ${candidate.label}: ${page.url} (${candidate.terminalReason}${candidate.terminalDetail ? `: ${candidate.terminalDetail}` : ''})`);
        } else if (candidateEligible(candidate)) {
          gaps.push(`Unexplained eligible interaction ${candidate.label}: ${page.url}`);
        }
      }
    }

    return {
      score,
      pageCoverage: Math.round(pageCoverageRatio * 100),
      interactionCoverage: Math.round(rawCoverageRatio * 100),
      rawInteractionCoverage: Math.round(rawCoverageRatio * 100),
      eligibleInteractionCoverage: Math.round(eligibleCoverageRatio * 100),
      discoveredInteractions: allCandidates.length,
      allowedInteractions: allowedCandidates.length,
      eligibleInteractions: eligibleCandidates.length,
      exercisedEligibleInteractions: exercisedEligible,
      explainedEligibleGaps,
      unexplainedEligibleGaps,
      gapReasonCounts,
      pages: pages
        .map((page) => {
          const candidates = [...page.candidates.values()];
          const eligibleOnPage = candidates.filter((candidate) => candidate.exercised || candidateEligible(candidate));
          return {
            url: page.url,
            depth: page.depth,
            visited: page.visited,
            visits: page.visits,
            discoveredCandidates: candidates.length,
            actionableCandidates: candidates.filter((candidate) => candidate.allowed).length,
            eligibleCandidates: eligibleOnPage.length,
            exercisedCandidates: eligibleOnPage.filter((candidate) => candidate.exercised).length,
            terminalEligibleCandidates: eligibleOnPage.filter((candidate) => !candidate.exercised && Boolean(candidate.terminalReason)).length,
            unexplainedEligibleCandidates: eligibleOnPage.filter((candidate) => !candidate.exercised && !candidate.terminalReason).length,
            blockedCandidates: candidates.filter((candidate) => !candidate.allowed).length,
            errors: page.errors,
          };
        })
        .sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)),
      gaps: gaps.slice(0, 100),
      terminalGaps: terminalGaps.slice(0, 100),
    };
  }
}
