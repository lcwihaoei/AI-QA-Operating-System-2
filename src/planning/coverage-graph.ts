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
  terminalReason?: CoverageTerminalReason;
};

type PageState = {
  url: string;
  depth: number;
  visited: boolean;
  visits: number;
  errors: number;
  candidates: Map<string, CandidateState>;
};

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

  discoverCandidate(url: string, candidate: ExplorationCandidate, risk: CandidateRisk, allowed: boolean): void {
    let page = this.pages.get(url);
    if (!page) {
      this.discoverPage(url, 0);
      page = this.pages.get(url)!;
    }
    const current = page.candidates.get(candidate.id);
    if (current) {
      current.risk = risk;
      current.allowed = allowed;
      current.label = candidate.label || candidate.kind;
      // A candidate observed again in a fresh DOM state is active again. Clear
      // prior terminal explanations unless the candidate was already exercised.
      if (!current.exercised) current.terminalReason = undefined;
      return;
    }
    page.candidates.set(candidate.id, {
      id: candidate.id,
      label: candidate.label || candidate.kind,
      risk,
      allowed,
      exercised: false,
    });
  }

  markCandidateExercised(url: string, candidateId: string): void {
    const candidate = this.pages.get(url)?.candidates.get(candidateId);
    if (candidate) {
      candidate.exercised = true;
      candidate.terminalReason = undefined;
    }
  }

  markCandidateTerminal(url: string, candidateId: string, reason: CoverageTerminalReason): void {
    const candidate = this.pages.get(url)?.candidates.get(candidateId);
    if (!candidate || !candidate.allowed || candidate.exercised) return;
    candidate.terminalReason = reason;
  }

  markRemainingEligibleTerminal(reason: CoverageTerminalReason, url?: string): void {
    const pages = url ? [this.pages.get(url)].filter((page): page is PageState => Boolean(page)) : [...this.pages.values()];
    for (const page of pages) {
      for (const candidate of page.candidates.values()) {
        if (candidate.allowed && !candidate.exercised) candidate.terminalReason = reason;
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

    let eligible = 0;
    let exercised = 0;
    let explainedEligibleGaps = 0;
    let unexplainedEligibleGaps = 0;
    const terminalGaps: CoverageTerminalGap[] = [];

    for (const page of pages) {
      for (const candidate of page.candidates.values()) {
        if (!candidate.allowed) continue;
        eligible += 1;
        if (candidate.exercised) {
          exercised += 1;
          continue;
        }
        if (candidate.terminalReason) {
          explainedEligibleGaps += 1;
          terminalGaps.push({
            scope: 'interaction',
            url: page.url,
            candidateId: candidate.id,
            label: candidate.label,
            reason: candidate.terminalReason,
            explained: true,
          });
        } else {
          unexplainedEligibleGaps += 1;
        }
      }
    }

    const interactionCoverageRatio = eligible === 0 ? (visitedPages > 0 ? 1 : 0) : exercised / eligible;
    const score = Math.round((pageCoverageRatio * 0.55 + interactionCoverageRatio * 0.45) * 100);

    const gaps: string[] = [];
    for (const page of pages) {
      if (!page.visited) gaps.push(`Unvisited page: ${page.url}`);
      for (const candidate of page.candidates.values()) {
        if (!candidate.allowed || candidate.exercised) continue;
        if (candidate.terminalReason) {
          gaps.push(`Unexercised ${candidate.label}: ${page.url} (explained: ${candidate.terminalReason})`);
        } else {
          gaps.push(`Unexplained eligible interaction ${candidate.label}: ${page.url}`);
        }
      }
    }

    return {
      score,
      pageCoverage: Math.round(pageCoverageRatio * 100),
      interactionCoverage: Math.round(interactionCoverageRatio * 100),
      eligibleInteractions: eligible,
      exercisedEligibleInteractions: exercised,
      explainedEligibleGaps,
      unexplainedEligibleGaps,
      pages: pages
        .map((page) => {
          const candidates = [...page.candidates.values()];
          const eligibleCandidates = candidates.filter((candidate) => candidate.allowed);
          return {
            url: page.url,
            depth: page.depth,
            visited: page.visited,
            visits: page.visits,
            discoveredCandidates: candidates.length,
            actionableCandidates: eligibleCandidates.length,
            eligibleCandidates: eligibleCandidates.length,
            exercisedCandidates: eligibleCandidates.filter((candidate) => candidate.exercised).length,
            terminalEligibleCandidates: eligibleCandidates.filter((candidate) => !candidate.exercised && Boolean(candidate.terminalReason)).length,
            unexplainedEligibleCandidates: eligibleCandidates.filter((candidate) => !candidate.exercised && !candidate.terminalReason).length,
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
