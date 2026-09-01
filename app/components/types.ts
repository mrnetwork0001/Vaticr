export interface EvidenceItem {
  headline_id: string;
  title: string;
  source: string;
  age_sec: number;
  log_likelihood_ratio: number;
  decay: number;
}

export interface Forecast {
  asset: string;
  market_id: string | null;
  symbol: string | null;
  open_price: number;
  spot: number;
  seconds_left: number;
  window_sec: number;
  annual_vol: number;
  vol_source: "realized" | "fallback";
  prior: number;
  posterior: number;
  evidence_log_odds: number;
  evidence: EvidenceItem[];
  computed_at: number;
  degraded: boolean;
  note: string;
}

export interface ForecastEnvelope {
  forecast: Forecast;
  expiry: number;
  trading_start: number;
  interval_sec: number;
  status: string;
  oracle_question_id: string | null;
  receipt_url: string | null;
}

export interface Headline {
  id: string;
  source: string;
  title: string;
  url: string;
  published_at: number;
  assets: string[];
  sentiment: number;
  salience: number;
  credibility: number;
  scorer: "lexicon" | "llm";
  rationale: string;
}

export interface Settlement {
  market_id: string;
  symbol: string;
  asset: string;
  expiry: number;
  onchain_outcome: string | null;
  derived_outcome: string | null;
  open_reference: number | null;
  close_reference: number | null;
  verdict: string;
  oracle_question_id: string | null;
  receipt_url: string | null;
}

export interface AuditResponse {
  verified: number;
  total: number;
  reference: string;
  settlements: Settlement[];
}

export interface Health {
  ok: boolean;
  network: string;
  headlines_in_window: number;
  last_scan: number;
  llm_classifier: string;
  feeds: number;
}
