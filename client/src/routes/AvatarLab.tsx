import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, ProfileAvatar } from '@mtg/shared';
import { AVATAR_PRESETS, type AvatarPreset } from '../account/avatarPresets.js';
import { useCardSearch } from '../cardDb/useCardSearch.js';
import { artCropUrl, CroppedArt } from '../components/Avatar.js';
import { CropStage } from '../components/AvatarEditorSheet.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { getOracleCard, getPrinting } from '../db/queries.js';
import { db } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { Page } from './Page.js';

// Curator for the starting-profile-picture list (account/avatarPresets.ts).
// Dev harness, deliberately not in the nav: search a card (or roll a random
// one), frame the art, add it to the working list, then copy the list out as
// the exact lines that file wants. The working list lives in settings, so
// tuning survives a reload.

const KEY = 'avatarLabPresets';
const TILE = 72;

/** What the crop editor needs; the lab only ever hands it real card rows. */
type Card = Priced<OracleCard>;

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** The exact shape of a line in avatarPresets.ts. */
function toTsLines(list: AvatarPreset[]): string {
  return list
    .map(
      (p) =>
        `  { scryfallId: '${p.scryfallId}', x: ${p.x}, y: ${p.y}, zoom: ${p.zoom}, name: ${JSON.stringify(p.name)} },`,
    )
    .join('\n');
}

/**
 * A random card worth a portrait: creatures and planeswalkers only (a random
 * row from the whole DB is usually a land or an instant) and it must have art.
 */
async function rollRandomCard(): Promise<Card | null> {
  const total = await db.oracleCards.count();
  if (total === 0) return null;
  for (let tries = 0; tries < 40; tries++) {
    const row = await db.oracleCards
      .offset(Math.floor(Math.random() * total))
      .limit(1)
      .first();
    if (!row || !artCropUrl(row.imageNormal)) continue;
    if (!/Creature|Planeswalker/.test(row.typeLine)) continue;
    return (await getOracleCard(row.oracleId)) ?? null;
  }
  return null;
}

/** One saved preset, rendered at avatar size straight from the local card DB. */
function PresetTile({
  preset,
  onEdit,
  onRemove,
}: {
  preset: AvatarPreset;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const printing = useLiveQuery(() => getPrinting(preset.scryfallId), [preset.scryfallId]);
  const src = artCropUrl(printing?.imageNormal);
  return (
    <div className="lab-tile">
      <button className="lab-tile-art" onClick={onEdit} title={`${preset.name} — tap to retune`}>
        <span className="avatar" style={{ width: TILE, height: TILE }}>
          {src ? <CroppedArt src={src} crop={preset} size={TILE} /> : <span className="lab-tile-missing">?</span>}
        </span>
      </button>
      <span className="lab-tile-name">{preset.name}</span>
      <button className="lab-tile-remove ghost" onClick={onRemove} aria-label={`Remove ${preset.name}`}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export function AvatarLab() {
  const toast = useToast();
  const [list, setList] = useState<AvatarPreset[] | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [editing, setEditing] = useState<{ index: number; avatar: ProfileAvatar } | null>(null);
  const [query, setQuery] = useState('');
  const { results } = useCardSearch(query, { limit: 20, enabled: query.trim().length >= 2 });

  useEffect(() => {
    void getSetting<AvatarPreset[]>(KEY).then((saved) => setList(saved ?? AVATAR_PRESETS));
  }, []);

  function commit(next: AvatarPreset[]) {
    setList(next);
    void setSetting(KEY, next);
  }

  function add(avatar: ProfileAvatar) {
    if (!card || !list) return;
    const preset: AvatarPreset = {
      scryfallId: avatar.scryfallId,
      x: round(avatar.x, 4),
      y: round(avatar.y, 4),
      zoom: round(avatar.zoom, 3),
      name: card.name,
    };
    const next = [...list];
    if (editing) next[editing.index] = preset;
    else next.push(preset);
    commit(next);
    setCard(null);
    setEditing(null);
    toast(editing ? `Retuned ${preset.name}` : `Added ${preset.name} (${next.length})`);
  }

  async function editPreset(index: number) {
    const preset = list?.[index];
    if (!preset) return;
    const printing = await getPrinting(preset.scryfallId);
    const oracle = printing && (await getOracleCard(printing.oracleId));
    if (!oracle) {
      toast('That printing is not in this card DB.');
      return;
    }
    setEditing({ index, avatar: preset });
    setCard(oracle);
  }

  async function roll() {
    const next = await rollRandomCard();
    if (!next) {
      toast('No cards in the DB yet.');
      return;
    }
    setEditing(null);
    setCard(next);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied.`);
    } catch {
      toast('Clipboard refused — select the text below instead.');
    }
  }

  if (!list) return <Page title="Avatar lab" />;

  return (
    <Page title="Avatar lab">
      <p className="fine-print">
        Starting profile pictures. Frame a card, add it to the list, then copy the lines into
        client/src/account/avatarPresets.ts. {list.length} in the list.
      </p>

      {card ? (
        <CropStage
          card={card}
          initial={editing?.avatar}
          saveLabel={editing ? 'Save crop' : 'Add to list'}
          onSave={add}
          onBack={() => {
            setCard(null);
            setEditing(null);
          }}
          onCancel={() => {
            setCard(null);
            setEditing(null);
          }}
        />
      ) : (
        <>
          <div className="lab-pick">
            <input
              className="search-input"
              placeholder="Search any card…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button onClick={() => void roll()}>Random card</button>
          </div>
          {results.length > 0 && (
            <ul className="menu-list avatar-results">
              {results.map((c) => (
                <li key={c.oracleId}>
                  <button
                    className="menu-item menu-item-btn"
                    onClick={() => {
                      setEditing(null);
                      setCard(c);
                      setQuery('');
                    }}
                  >
                    {artCropUrl(c.imageNormal) ? (
                      <img className="avatar-result-thumb" src={artCropUrl(c.imageNormal)!} alt="" loading="lazy" />
                    ) : (
                      <span className="avatar-result-thumb" />
                    )}
                    <span className="deck-line">
                      <span className="deck-name">{c.name}</span>
                      <span className="deck-meta">{c.typeLine}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="lab-grid">
        {list.map((preset, i) => (
          <PresetTile
            key={`${preset.scryfallId}-${i}`}
            preset={preset}
            onEdit={() => void editPreset(i)}
            onRemove={() => commit(list.filter((_, j) => j !== i))}
          />
        ))}
      </div>

      <div className="lab-actions">
        <button onClick={() => void copy(toTsLines(list), 'Preset lines')}>Copy TS lines</button>
        <button onClick={() => void copy(JSON.stringify(list), 'JSON')}>Copy JSON</button>
        <button
          onClick={() => {
            const raw = prompt('Paste a JSON preset list (replaces the working list):');
            if (!raw) return;
            try {
              const parsed = JSON.parse(raw) as AvatarPreset[];
              if (!Array.isArray(parsed)) throw new Error('not a list');
              commit(parsed);
              toast(`Loaded ${parsed.length} presets.`);
            } catch {
              toast('That is not a JSON list.');
            }
          }}
        >
          Paste JSON
        </button>
        <button className="ghost" onClick={() => commit(AVATAR_PRESETS)}>
          Reset to shipped
        </button>
      </div>

      <textarea className="lab-export" readOnly rows={8} value={toTsLines(list)} onFocus={(e) => e.target.select()} />
    </Page>
  );
}
