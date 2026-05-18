import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Clipboard,
  Copy,
  ExternalLink,
  Gauge,
  Globe2,
  Loader2,
  Mail,
  MapPin,
  Radar,
  Search,
  Sparkles
} from "lucide-react";
import { defaultCity, usCities } from "./data/cities";
import { niches } from "./data/niches";

const stageOrder = ["Scraping", "Extracting Contact Info", "Capturing Screenshots", "Auditing", "Drafting"];

function cityKey(entry) {
  return `${entry.city}|||${entry.state}`;
}

function scoreTone(score) {
  if (score > 75) {
    return {
      ring: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
      text: "text-emerald-300",
      bar: "bg-emerald-400"
    };
  }

  if (score >= 50) {
    return {
      ring: "border-amber-400/40 bg-amber-400/10 text-amber-200",
      text: "text-amber-300",
      bar: "bg-amber-400"
    };
  }

  return {
    ring: "border-rose-400/40 bg-rose-400/10 text-rose-200",
    text: "text-rose-300",
    bar: "bg-rose-400"
  };
}

async function resolveApiBase() {
  const candidates = ["/api", "/.netlify/functions/api"];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/health`, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (response.ok) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return "/api";
}

export default function App() {
  const [selectedNiche, setSelectedNiche] = useState(niches[0].value);
  const [selectedCityKey, setSelectedCityKey] = useState(cityKey(defaultCity));
  const [leads, setLeads] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");
  const [metaMessage, setMetaMessage] = useState("");
  const [pipeline, setPipeline] = useState({
    stage: "Scraping",
    progress: 0,
    detail: "Idle"
  });
  const [apiBase, setApiBase] = useState("/api");
  const streamRef = useRef(null);

  const selectedCity = useMemo(
    () => usCities.find((entry) => cityKey(entry) === selectedCityKey) ?? defaultCity,
    [selectedCityKey]
  );

  useEffect(() => {
    let cancelled = false;

    resolveApiBase().then((resolvedBase) => {
      if (!cancelled) {
        setApiBase(resolvedBase);
      }
    });

    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, []);

  function launchSearch() {
    streamRef.current?.close();
    setLeads([]);
    setError("");
    setMetaMessage("");
    setIsRunning(true);
    setPipeline({
      stage: "Scraping",
      progress: 2,
      detail: `${selectedCity.city}, ${selectedCity.state}`
    });

    const params = new URLSearchParams({
      niche: selectedNiche,
      city: selectedCity.city,
      state: selectedCity.state
    });

    const stream = new EventSource(`${apiBase}/leads/stream?${params.toString()}`);
    streamRef.current = stream;

    stream.addEventListener("stage", (event) => {
      const payload = JSON.parse(event.data);
      setPipeline({
        stage: payload.stage,
        progress: payload.progress,
        detail: payload.detail
      });
    });

    stream.addEventListener("meta", (event) => {
      const payload = JSON.parse(event.data);
      setMetaMessage(payload.message ?? "");
    });

    stream.addEventListener("lead", (event) => {
      const lead = JSON.parse(event.data);
      setLeads((current) => [...current, lead]);
    });

    stream.addEventListener("done", (event) => {
      const payload = JSON.parse(event.data);
      setPipeline({
        stage: "Drafting",
        progress: payload.progress ?? 100,
        detail: payload.message ?? "Complete"
      });
      setIsRunning(false);
      stream.close();
    });

    stream.addEventListener("error", (event) => {
      if (event instanceof MessageEvent && event.data) {
        const payload = JSON.parse(event.data);
        setError(payload.message ?? "Search failed.");
      } else if (isRunning) {
        setError("The lead stream disconnected.");
      }

      setIsRunning(false);
      stream.close();
    });
  }

  const currentStageIndex = Math.max(stageOrder.indexOf(pipeline.stage), 0);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 rounded-lg border border-white/5 bg-slate-950/60 px-5 py-5 shadow-glow lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-lg border border-indigo-300/20 bg-indigo-500/15 text-indigo-200">
                <Radar className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-normal text-white">ProspectPilot</h1>
                <p className="mt-1 text-sm text-slate-400">Agency-in-a-box outreach cockpit</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Leads" value={leads.length} />
            <Metric label="Stage" value={`${currentStageIndex + 1}/5`} />
            <Metric label="City" value={selectedCity.city} />
            <Metric label="State" value={selectedCity.state} />
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <SearchPanel
              selectedNiche={selectedNiche}
              selectedCityKey={selectedCityKey}
              selectedCity={selectedCity}
              isRunning={isRunning}
              onNicheChange={setSelectedNiche}
              onCityChange={setSelectedCityKey}
              onLaunch={launchSearch}
            />
            <PipelinePanel
              pipeline={pipeline}
              currentStageIndex={currentStageIndex}
              isRunning={isRunning}
              metaMessage={metaMessage}
              error={error}
            />
          </div>

          <ResultsFeed leads={leads} isRunning={isRunning} />
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/5 bg-slate-800/70 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="truncate text-sm font-medium text-slate-100">{value}</div>
    </div>
  );
}

function SearchPanel({
  selectedNiche,
  selectedCityKey,
  selectedCity,
  isRunning,
  onNicheChange,
  onCityChange,
  onLaunch
}) {
  return (
    <section className="rounded-lg border border-white/5 bg-slate-800 p-5">
      <div className="mb-5 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-500/15 text-indigo-200">
          <Search className="h-4 w-4" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-white">Search Leads</h2>
      </div>

      <div className="grid gap-4">
        <label className="grid gap-2">
          <span className="text-sm font-medium text-slate-300">Niche</span>
          <select
            value={selectedNiche}
            onChange={(event) => onNicheChange(event.target.value)}
            className="h-11 rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none transition focus:border-indigo-300/70"
            disabled={isRunning}
          >
            {niches.map((niche) => (
              <option key={niche.value} value={niche.value}>
                {niche.label}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium text-slate-300">City</span>
          <select
            value={selectedCityKey}
            onChange={(event) => onCityChange(event.target.value)}
            className="h-11 rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none transition focus:border-indigo-300/70"
            disabled={isRunning}
          >
            {usCities.map((entry) => (
              <option key={cityKey(entry)} value={cityKey(entry)}>
                {entry.city}, {entry.state}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium text-slate-300">State</span>
          <input
            value={selectedCity.state}
            readOnly
            disabled
            className="h-11 rounded-lg border border-white/10 bg-slate-950/70 px-3 text-sm text-slate-400 outline-none"
          />
        </label>

        <button
          type="button"
          onClick={onLaunch}
          disabled={isRunning}
          className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {isRunning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
          {isRunning ? "Processing" : "Launch Search"}
        </button>
      </div>
    </section>
  );
}

function PipelinePanel({ pipeline, currentStageIndex, isRunning, metaMessage, error }) {
  return (
    <section className="rounded-lg border border-white/5 bg-slate-800 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-400/10 text-cyan-200">
            <Gauge className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-semibold text-white">Pipeline</h2>
        </div>
        <span className="text-sm font-medium text-slate-300">{Math.round(pipeline.progress)}%</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-slate-950">
        <motion.div
          className="h-full rounded-full bg-indigo-400"
          animate={{ width: `${pipeline.progress}%` }}
          transition={{ type: "spring", stiffness: 90, damping: 18 }}
        />
      </div>

      <div className="mt-4 grid gap-2">
        {stageOrder.map((stage, index) => {
          const isActive = pipeline.stage === stage;
          const isDone = index < currentStageIndex || (!isRunning && pipeline.progress === 100);

          return (
            <div
              key={stage}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                isActive
                  ? "border-indigo-300/40 bg-indigo-400/10 text-indigo-100"
                  : isDone
                    ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100"
                    : "border-white/5 bg-slate-950/50 text-slate-500"
              }`}
            >
              <span className="grid h-5 w-5 place-items-center rounded-full border border-current/30 text-[11px]">
                {isDone ? <Check className="h-3 w-3" aria-hidden="true" /> : index + 1}
              </span>
              <span className="truncate">{stage}</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 min-h-6 text-sm text-slate-400" aria-live="polite">
        {error ? <span className="text-rose-300">{error}</span> : metaMessage || pipeline.detail}
      </div>
    </section>
  );
}

function ResultsFeed({ leads, isRunning }) {
  return (
    <section className="min-h-[640px] rounded-lg border border-white/5 bg-slate-800 p-4 sm:p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-400/10 text-emerald-200">
            <Globe2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-semibold text-white">Results Feed</h2>
        </div>
        {isRunning && (
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950 px-3 py-1 text-xs text-slate-300">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Live
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {leads.length > 0 ? (
          <motion.div className="grid gap-4" initial="hidden" animate="show">
            {leads.map((lead, index) => (
              <LeadCard key={`${lead.id}-${index}`} lead={lead} index={index} />
            ))}
          </motion.div>
        ) : (
          <motion.div
            className="grid min-h-[520px] place-items-center rounded-lg border border-dashed border-white/10 bg-slate-950/40 text-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <div className="max-w-xs px-4">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg border border-white/10 bg-slate-800 text-slate-300">
                <Clipboard className="h-5 w-5" aria-hidden="true" />
              </div>
              <p className="mt-4 text-sm font-medium text-slate-300">{isRunning ? "Building lead cards" : "No leads yet"}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function LeadCard({ lead, index }) {
  const [activeTab, setActiveTab] = useState("audit");
  const [manualEmail, setManualEmail] = useState(lead.foundEmail ?? "");
  const [copied, setCopied] = useState("");
  const tone = scoreTone(lead.score);

  useEffect(() => {
    if (lead.foundEmail && !manualEmail) {
      setManualEmail(lead.foundEmail);
    }
  }, [lead.foundEmail, manualEmail]);

  async function copyText(value, key) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1400);
  }

  const fullDraft = `To: ${manualEmail || "[email needed]"}\nSubject: ${lead.coldEmail.subject}\n\n${lead.coldEmail.body}`;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ delay: index * 0.06, duration: 0.28, ease: "easeOut" }}
      className="overflow-hidden rounded-lg border border-white/5 bg-slate-950/70"
    >
      <div className="grid gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-lg border border-white/5 bg-slate-900">
          <div className="aspect-[16/10] bg-slate-950">
            {lead.screenshotUrl ? (
              <img
                src={lead.screenshotUrl}
                alt={`${lead.name} website screenshot`}
                className="h-full w-full object-cover object-top"
                loading="lazy"
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-slate-500">Screenshot unavailable</div>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="truncate text-xl font-semibold text-white">{lead.name}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-400">
                <a
                  href={lead.website}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 text-indigo-200 transition hover:text-indigo-100"
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{lead.website.replace(/^https?:\/\//, "")}</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </a>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{lead.location || `${lead.city}, ${lead.state}`}</span>
                </span>
              </div>
            </div>

            <div className={`shrink-0 rounded-lg border px-3 py-2 text-right ${tone.ring}`}>
              <div className="text-xs text-current/75">Audit Score</div>
              <div className="text-2xl font-semibold">{lead.score}</div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
            <div className="rounded-lg border border-white/5 bg-slate-900 px-3 py-3">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase text-slate-500">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                Email Section
              </div>
              {lead.foundEmail ? (
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-2 text-sm text-emerald-200">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                    <span className="truncate">{lead.foundEmail}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => copyText(lead.foundEmail, "email")}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2 text-xs text-slate-200 transition hover:bg-white/5"
                  >
                    {copied === "email" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                    Copy
                  </button>
                </div>
              ) : (
                <div className="text-sm text-amber-200">Email needed</div>
              )}
            </div>

            <div className="rounded-lg border border-white/5 bg-slate-900 px-3 py-3">
              <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase text-slate-500">
                <span>Score</span>
                <span className={tone.text}>{lead.score}/100</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-950">
                <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${lead.score}%` }} />
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="inline-grid grid-cols-2 rounded-lg border border-white/10 bg-slate-900 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("audit")}
                className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                  activeTab === "audit" ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Audit Detail
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("email")}
                className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                  activeTab === "email" ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Cold Email
              </button>
            </div>

            <div className="mt-3 rounded-lg border border-white/5 bg-slate-900 p-4">
              {activeTab === "audit" ? (
                <div className="grid gap-3">
                  <p className="text-sm leading-6 text-slate-300">{lead.auditDetail}</p>
                  <div className="grid gap-2">
                    {(lead.findings ?? []).map((finding) => (
                      <div key={finding} className="flex gap-2 text-sm text-slate-300">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-300" />
                        <span>{finding}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-300">To Email</span>
                    <input
                      value={manualEmail}
                      onChange={(event) => setManualEmail(event.target.value)}
                      placeholder="email needed"
                      className="h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-indigo-300/70"
                    />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-sm font-medium text-slate-300">Subject</span>
                    <input
                      value={lead.coldEmail.subject}
                      readOnly
                      className="h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-slate-200 outline-none"
                    />
                  </label>

                  <div className="grid gap-2">
                    <span className="text-sm font-medium text-slate-300">Body</span>
                    <textarea
                      value={lead.coldEmail.body}
                      readOnly
                      rows={6}
                      className="min-h-36 resize-y rounded-lg border border-white/10 bg-slate-950 px-3 py-3 text-sm leading-6 text-slate-200 outline-none"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => copyText(fullDraft, "draft")}
                    className="inline-flex h-10 w-fit items-center gap-2 rounded-lg border border-white/10 px-3 text-sm font-medium text-slate-100 transition hover:bg-white/5"
                  >
                    {copied === "draft" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                    Copy Draft
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.article>
  );
}
