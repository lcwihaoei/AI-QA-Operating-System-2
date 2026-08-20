import type { CandidateRisk, CoverageSnapshot, ExplorationCandidate } from '../core/types.js';

type CandidateState = {
  id: string;
  label: string;
  risk: CandidateRisk;
  allowed: boolean;
  exercised: boolean;
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
    if (candidate) candidate.exercised = true;
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
    const pageCoverage = pages.length === 0 ? 0 : visitedPages / pages.length;

    let actionable = 0;
    let exercised = 0;
    for (const page of pages) {
      for (const candidate of page.candidates.values()) {
        if (!candidate.allowed) continue;
        actionable += 1;
        if (candidate.exercised) exercised += 1;
      }
    }
    const interactionCoverage = actionable === 0 ? (visitedPages > 0 ? 1 : 0) : exercised / actionable;
    const score = Math.round((pageCoverage * 0.55 + interactionCoverage * 0.45) * 100);

    const gaps: string[] = [];
    for (const page of pages) {
      if (!page.visited) gaps.push(`Unvisited page: ${page.url}`);
      for (const candidate of page.candidates.values()) {
        if (candidate.allowed && !candidate.exercised) {
          gaps.push(`Unexercised ${candidate.label}: ${page.url}`);
        }
      }
    }

    return {
      score,
      pageCoverage: Math.round(pageCoverage * 100),
      interactionCoverage: Math.round(interactionCoverage * 100),
      pages: pages
        .map((page) => {
          const candidates = [...page.candidates.values()];
          return {
            url: page.url,
            depth: page.depth,
            visited: page.visited,
            visits: page.visits,
            discoveredCandidates: candidates.length,
            actionableCandidates: candidates.filter((candidate) => candidate.allowed).length,
            exercisedCandidates: candidates.filter((candidate) => candidate.exercised).length,
            blockedCandidates: candidates.filter((candidate) => !candidate.allowed).length,
            errors: page.errors,
          };
        })
        .sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)),
      gaps: gaps.slice(0, 50),
    };
  }
}
