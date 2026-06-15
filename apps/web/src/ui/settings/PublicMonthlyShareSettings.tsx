"use client";

import { type ChangeEvent, type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type {
  MonthlyCategoryShareAccessLevel,
  MonthlyCategoryShareItem,
  MonthlyCategoryShareSettingsResponse,
} from "@/server/community/monthlyCategoryShareTypes";
import controlStyles from "@/ui/Controls.module.css";
import { useCopyToast } from "@/ui/hooks/useCopyToast";

import settingsStyles from "./SettingsForm.module.css";
import styles from "./PublicMonthlyShareSettings.module.css";

type Props = Readonly<{
  demoMode: boolean;
}>;

type SettingsRequestBody = {
  displayLabel?: string;
  monthFrom?: string | null;
  monthTo?: string | null;
};

type IndexingRequestBody = {
  indexingEnabled: boolean;
  confirmationPhrase?: string;
};

type PendingAction = "load" | "settings" | "items" | "enable" | "disable" | "indexing" | "rotate" | null;

const SETTINGS_URL = "/api/community/monthly-category-share";

const ACCESS_LEVELS: ReadonlyArray<MonthlyCategoryShareAccessLevel> = [
  "category_only",
  "monthly_values",
];

const EMPTY_RESPONSE: MonthlyCategoryShareSettingsResponse = {
  settings: {
    enabled: false,
    indexingEnabled: false,
    displayLabel: "",
    monthFrom: null,
    monthTo: null,
  },
  dashboardUrl: null,
  jsonUrl: null,
  selectedItems: [],
  availableSpendCategories: [],
};

const createDraftAccessMap = (
  items: ReadonlyArray<MonthlyCategoryShareItem>,
): ReadonlyMap<string, MonthlyCategoryShareAccessLevel> =>
  new Map(items.map((item): readonly [string, MonthlyCategoryShareAccessLevel] => [item.category, item.accessLevel]));

const normalizeMonthInput = (value: string): string | null =>
  value === "" ? null : value;

const monthToInputValue = (value: string | null): string =>
  value === null ? "" : value;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasSettingsRequestBody = (body: SettingsRequestBody): boolean =>
  Object.keys(body).length > 0;

const sortItemsByCategory = (
  items: ReadonlyArray<MonthlyCategoryShareItem>,
): ReadonlyArray<MonthlyCategoryShareItem> =>
  [...items].sort((left, right): number => left.category.localeCompare(right.category));

const readSettingsResponse = async (response: Response): Promise<MonthlyCategoryShareSettingsResponse> => {
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json() as MonthlyCategoryShareSettingsResponse;
};

const getAccessLevelLabelKey = (accessLevel: MonthlyCategoryShareAccessLevel): string => {
  if (accessLevel === "category_only") return "publicShare.accessCategoryOnly";
  return "publicShare.accessMonthlyValues";
};

export const PublicMonthlyShareSettings = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const { toastMessage, copyToClipboard } = useCopyToast();
  const [response, setResponse] = useState<MonthlyCategoryShareSettingsResponse>(EMPTY_RESPONSE);
  const [loaded, setLoaded] = useState<boolean>(props.demoMode);
  const [displayLabel, setDisplayLabel] = useState<string>(EMPTY_RESPONSE.settings.displayLabel);
  const [monthFrom, setMonthFrom] = useState<string>(monthToInputValue(EMPTY_RESPONSE.settings.monthFrom));
  const [monthTo, setMonthTo] = useState<string>(monthToInputValue(EMPTY_RESPONSE.settings.monthTo));
  const [pendingAction, setPendingAction] = useState<PendingAction>(props.demoMode ? null : "load");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [selectedAccessLevel, setSelectedAccessLevel] = useState<MonthlyCategoryShareAccessLevel | "">("");
  const [addMonthlyValuesConfirmed, setAddMonthlyValuesConfirmed] = useState<boolean>(false);
  const [itemAccessDrafts, setItemAccessDrafts] = useState<ReadonlyMap<string, MonthlyCategoryShareAccessLevel>>(
    createDraftAccessMap(EMPTY_RESPONSE.selectedItems),
  );
  const [upgradeConfirmations, setUpgradeConfirmations] = useState<ReadonlySet<string>>(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const syncResponse = useCallback((nextResponse: MonthlyCategoryShareSettingsResponse): void => {
    setResponse(nextResponse);
    setDisplayLabel(nextResponse.settings.displayLabel);
    setMonthFrom(monthToInputValue(nextResponse.settings.monthFrom));
    setMonthTo(monthToInputValue(nextResponse.settings.monthTo));
    setAddMonthlyValuesConfirmed(false);
    setItemAccessDrafts(createDraftAccessMap(nextResponse.selectedItems));
    setUpgradeConfirmations(new Set<string>());
  }, []);

  useEffect(() => {
    if (props.demoMode) {
      syncResponse(EMPTY_RESPONSE);
      setLoaded(true);
      setPendingAction(null);
      return;
    }

    let active = true;
    setLoaded(false);
    setPendingAction("load");
    setError(null);

    fetch(SETTINGS_URL, { method: "GET", cache: "no-store" })
      .then(readSettingsResponse)
      .then((nextResponse: MonthlyCategoryShareSettingsResponse): void => {
        if (!active) return;
        syncResponse(nextResponse);
        setLoaded(true);
      })
      .catch((fetchError: unknown): void => {
        if (!active) return;
        setError(formatError(fetchError));
        setLoaded(true);
      })
      .finally((): void => {
        if (active) setPendingAction(null);
      });

    return () => {
      active = false;
    };
  }, [props.demoMode, syncResponse]);

  const selectedCategories = useMemo<ReadonlySet<string>>(
    () => new Set(response.selectedItems.map((item): string => item.category)),
    [response.selectedItems],
  );

  const availableCategoriesForAdd = useMemo<ReadonlyArray<string>>(
    () => response.availableSpendCategories.filter((category): boolean => !selectedCategories.has(category)),
    [response.availableSpendCategories, selectedCategories],
  );

  const settingsDirty = displayLabel !== response.settings.displayLabel
    || normalizeMonthInput(monthFrom) !== response.settings.monthFrom
    || normalizeMonthInput(monthTo) !== response.settings.monthTo;

  const controlsDisabled = props.demoMode || !loaded || pendingAction !== null;
  const categoryControlsDisabled = controlsDisabled || settingsDirty;
  const addingMonthlyValues = selectedAccessLevel === "monthly_values";
  const canAddCategory = selectedCategory !== "" && selectedAccessLevel !== "" && (!addingMonthlyValues || addMonthlyValuesConfirmed) && !categoryControlsDisabled;
  const canEnable = !response.settings.enabled && monthFrom !== "" && !controlsDisabled;
  const canToggleIndexing = response.settings.enabled && !controlsDisabled;
  const hasGeneratedLinks = response.dashboardUrl !== null || response.jsonUrl !== null;

  const buildSettingsRequestBody = useCallback((): SettingsRequestBody => {
    const body: SettingsRequestBody = {};
    const nextMonthFrom = normalizeMonthInput(monthFrom);
    const nextMonthTo = normalizeMonthInput(monthTo);

    if (displayLabel !== response.settings.displayLabel) {
      body.displayLabel = displayLabel;
    }
    if (nextMonthFrom !== response.settings.monthFrom) {
      body.monthFrom = nextMonthFrom;
    }
    if (nextMonthTo !== response.settings.monthTo) {
      body.monthTo = nextMonthTo;
    }

    return body;
  }, [displayLabel, monthFrom, monthTo, response.settings.displayLabel, response.settings.monthFrom, response.settings.monthTo]);

  const saveSettings = useCallback(async (action: Exclude<PendingAction, null>): Promise<boolean> => {
    const body = buildSettingsRequestBody();
    if (!hasSettingsRequestBody(body)) {
      return true;
    }

    setPendingAction(action);
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(SETTINGS_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      syncResponse(nextResponse);
      return true;
    } catch (saveError: unknown) {
      setError(formatError(saveError));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [buildSettingsRequestBody, syncResponse]);

  const saveItems = useCallback(async (
    selectedItems: ReadonlyArray<MonthlyCategoryShareItem>,
  ): Promise<boolean> => {
    setPendingAction("items");
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(`${SETTINGS_URL}/items`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: sortItemsByCategory(selectedItems) }),
      }));
      syncResponse(nextResponse);
      setSaved(true);
      return true;
    } catch (saveError: unknown) {
      setError(formatError(saveError));
      return false;
    } finally {
      setPendingAction(null);
    }
  }, [syncResponse]);

  const handleSaveSettings = useCallback(async (): Promise<void> => {
    const savedSettings = await saveSettings("settings");
    if (savedSettings) setSaved(true);
  }, [saveSettings]);

  const handleEnable = useCallback(async (): Promise<void> => {
    if (monthFrom === "") {
      setError(t("publicShare.startMonth"));
      return;
    }

    const savedSettings = await saveSettings("enable");
    if (!savedSettings) return;

    const confirmationPhrase = t("publicShare.confirmPublicLinkPhrase");
    const enteredPhrase = window.prompt([
      t("publicShare.offByDefault"),
      t("publicShare.manualCategoryWarning"),
      t("publicShare.freshnessPolicy"),
      t("publicShare.confirmPhraseInstruction"),
      confirmationPhrase,
    ].join("\n\n"));
    if (enteredPhrase === null) return;

    setPendingAction("enable");
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(`${SETTINGS_URL}/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationPhrase: enteredPhrase }),
      }));
      syncResponse(nextResponse);
      setSaved(true);
    } catch (enableError: unknown) {
      setError(formatError(enableError));
    } finally {
      setPendingAction(null);
    }
  }, [monthFrom, saveSettings, syncResponse, t]);

  const handleDisable = useCallback(async (): Promise<void> => {
    setPendingAction("disable");
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(`${SETTINGS_URL}/disable`, {
        method: "POST",
      }));
      syncResponse(nextResponse);
      setSaved(true);
    } catch (disableError: unknown) {
      setError(formatError(disableError));
    } finally {
      setPendingAction(null);
    }
  }, [syncResponse]);

  const handleIndexingToggle = useCallback(async (): Promise<void> => {
    const nextIndexingEnabled = !response.settings.indexingEnabled;
    const body: IndexingRequestBody = { indexingEnabled: nextIndexingEnabled };

    if (nextIndexingEnabled) {
      const confirmationPhrase = t("publicShare.confirmSearchIndexingPhrase");
      const enteredPhrase = window.prompt([
        t("publicShare.searchIndexingWarning"),
        t("publicShare.confirmPhraseInstruction"),
        confirmationPhrase,
      ].join("\n\n"));
      if (enteredPhrase === null) return;
      body.confirmationPhrase = enteredPhrase;
    }

    setPendingAction("indexing");
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(`${SETTINGS_URL}/indexing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      syncResponse(nextResponse);
      setSaved(true);
    } catch (indexingError: unknown) {
      setError(formatError(indexingError));
    } finally {
      setPendingAction(null);
    }
  }, [response.settings.indexingEnabled, syncResponse, t]);

  const handleRotateLink = useCallback(async (): Promise<void> => {
    const confirmed = window.confirm([
      t("publicShare.rotateLink"),
      t("publicShare.rotateLinkWarning"),
    ].join("\n\n"));
    if (!confirmed) return;

    setPendingAction("rotate");
    setError(null);
    setSaved(false);

    try {
      const nextResponse = await readSettingsResponse(await fetchWithCsrf(`${SETTINGS_URL}/rotate-token`, {
        method: "POST",
      }));
      syncResponse(nextResponse);
      setSaved(true);
    } catch (rotateError: unknown) {
      setError(formatError(rotateError));
    } finally {
      setPendingAction(null);
    }
  }, [syncResponse, t]);

  const handleAddCategory = useCallback(async (): Promise<void> => {
    if (selectedCategory === "" || selectedAccessLevel === "") return;
    if (settingsDirty) return;
    if (selectedAccessLevel === "monthly_values" && !addMonthlyValuesConfirmed) return;

    const nextItems = sortItemsByCategory([
      ...response.selectedItems,
      {
        direction: "spend",
        category: selectedCategory,
        accessLevel: selectedAccessLevel,
      },
    ]);

    const savedItems = await saveItems(nextItems);
    if (!savedItems) return;

    setSelectedCategory("");
    setSelectedAccessLevel("");
    setAddMonthlyValuesConfirmed(false);
  }, [addMonthlyValuesConfirmed, response.selectedItems, saveItems, selectedAccessLevel, selectedCategory, settingsDirty]);

  const handleDraftAccessChange = useCallback((
    category: string,
    accessLevel: MonthlyCategoryShareAccessLevel,
  ): void => {
    setItemAccessDrafts((currentDrafts): ReadonlyMap<string, MonthlyCategoryShareAccessLevel> => {
      const nextDrafts = new Map(currentDrafts);
      nextDrafts.set(category, accessLevel);
      return nextDrafts;
    });
    setUpgradeConfirmations((currentConfirmations): ReadonlySet<string> => {
      const nextConfirmations = new Set(currentConfirmations);
      nextConfirmations.delete(category);
      return nextConfirmations;
    });
    setSaved(false);
  }, []);

  const handleUpgradeConfirmationChange = useCallback((category: string, checked: boolean): void => {
    setUpgradeConfirmations((currentConfirmations): ReadonlySet<string> => {
      const nextConfirmations = new Set(currentConfirmations);
      if (checked) {
        nextConfirmations.add(category);
      } else {
        nextConfirmations.delete(category);
      }
      return nextConfirmations;
    });
  }, []);

  const handleSaveItem = useCallback(async (
    category: string,
    accessLevel: MonthlyCategoryShareAccessLevel,
  ): Promise<void> => {
    if (settingsDirty) return;
    const nextItems = response.selectedItems.map((item): MonthlyCategoryShareItem => (
      item.category === category ? { ...item, accessLevel } : item
    ));
    await saveItems(nextItems);
  }, [response.selectedItems, saveItems, settingsDirty]);

  const handleRemoveItem = useCallback(async (category: string): Promise<void> => {
    if (settingsDirty) return;
    const nextItems = response.selectedItems.filter((item): boolean => item.category !== category);
    await saveItems(nextItems);
  }, [response.selectedItems, saveItems, settingsDirty]);

  const dashboardUrl = response.dashboardUrl;
  const jsonUrl = response.jsonUrl;

  return (
    <div className={styles.shell} aria-busy={pendingAction !== null}>
      <div className={styles.statusRow}>
        <span className={cn(styles.statusBadge, response.settings.enabled ? styles.statusEnabled : styles.statusDisabled)}>
          {t(response.settings.enabled ? "publicShare.publicLinkEnabled" : "publicShare.publicLinkDisabled")}
        </span>
        <span className={cn(styles.statusBadge, response.settings.indexingEnabled ? styles.statusEnabled : styles.statusDisabled)}>
          {t(response.settings.indexingEnabled ? "publicShare.searchIndexingEnabled" : "publicShare.searchIndexingDisabled")}
        </span>
      </div>

      <div className={styles.warningStack}>
        <p className={styles.warningText}>{t("publicShare.offByDefault")}</p>
        <p className={styles.warningText}>{t("publicShare.freshnessPolicy")}</p>
        {props.demoMode && (
          <p className={styles.demoText}>
            {t("demo.banner")} {t("demo.bannerDetail")}
          </p>
        )}
      </div>

      {!loaded && <p className={styles.mutedText}>{t("common.loading")}</p>}

      <section className={styles.section}>
        <div className={styles.fieldsGrid}>
          <label className={styles.field} htmlFor="public-share-display-label">
            <span className={styles.label}>{t("publicShare.displayLabel")}</span>
            <input
              id="public-share-display-label"
              className={styles.input}
              type="text"
              value={displayLabel}
              placeholder={t("publicShare.displayLabelPlaceholder")}
              maxLength={80}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                setDisplayLabel(event.target.value);
                setSaved(false);
              }}
            />
            <span className={styles.hint}>{t("publicShare.emptyDisplayLabelHint")}</span>
          </label>

          <label className={styles.field} htmlFor="public-share-start-month">
            <span className={styles.label}>{t("publicShare.startMonth")}</span>
            <input
              id="public-share-start-month"
              className={styles.input}
              type="month"
              value={monthFrom}
              required
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                setMonthFrom(event.target.value);
                setSaved(false);
              }}
            />
          </label>

          <label className={styles.field} htmlFor="public-share-end-month">
            <span className={styles.label}>{t("publicShare.endMonth")}</span>
            <input
              id="public-share-end-month"
              className={styles.input}
              type="month"
              value={monthTo}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                setMonthTo(event.target.value);
                setSaved(false);
              }}
            />
          </label>
        </div>

        <div className={styles.actionRow}>
          <button
            className={settingsStyles.save}
            type="button"
            onClick={() => { void handleSaveSettings(); }}
            disabled={controlsDisabled || !settingsDirty}
          >
            {pendingAction === "settings" ? t("common.saving") : t("common.save")}
          </button>

          {response.settings.enabled ? (
            <button
              className={cn(settingsStyles.save, settingsStyles.saveDanger)}
              type="button"
              onClick={() => { void handleDisable(); }}
              disabled={controlsDisabled}
            >
              {t("publicShare.disable")}
            </button>
          ) : (
            <button
              className={cn(settingsStyles.save, settingsStyles.saveDanger)}
              type="button"
              onClick={() => { void handleEnable(); }}
              disabled={!canEnable}
            >
              {t("publicShare.enable")}
            </button>
          )}

          <button
            className={settingsStyles.save}
            type="button"
            onClick={() => { void handleIndexingToggle(); }}
            disabled={!canToggleIndexing}
          >
            {t(response.settings.indexingEnabled ? "publicShare.disableSearchIndexing" : "publicShare.enableSearchIndexing")}
          </button>

          {hasGeneratedLinks && (
            <button
              className={cn(settingsStyles.save, settingsStyles.saveDanger)}
              type="button"
              onClick={() => { void handleRotateLink(); }}
              disabled={controlsDisabled}
            >
              {t("publicShare.rotateLink")}
            </button>
          )}
        </div>

        <p className={styles.hint}>{t("publicShare.searchIndexingWarning")}</p>
        <p className={styles.hint}>{t("publicShare.disablePreservesLink")}</p>
      </section>

      {(dashboardUrl !== null || jsonUrl !== null) && (
        <section className={styles.section}>
          <div className={styles.generatedLinks}>
            {dashboardUrl !== null && (
              <div className={styles.generatedLink}>
                <span className={styles.label}>{t("publicShare.copyDashboardLink")}</span>
                <code className={styles.linkValue}>{dashboardUrl}</code>
                <button
                  className={controlStyles.segment}
                  type="button"
                  onClick={() => { copyToClipboard(dashboardUrl); }}
                  disabled={controlsDisabled}
                >
                  {t("publicShare.copyDashboardLink")}
                </button>
              </div>
            )}

            {jsonUrl !== null && (
              <div className={styles.generatedLink}>
                <span className={styles.label}>{t("publicShare.copyJsonLink")}</span>
                <code className={styles.linkValue}>{jsonUrl}</code>
                <button
                  className={controlStyles.segment}
                  type="button"
                  onClick={() => { copyToClipboard(jsonUrl); }}
                  disabled={controlsDisabled}
                >
                  {t("publicShare.copyJsonLink")}
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t("publicShare.categoryPicker")}</h2>
        <div className={styles.warningStack}>
          <p className={styles.warningText}>{t("publicShare.categorySafetyWarning")}</p>
          <p className={styles.warningText}>{t("publicShare.manualCategoryWarning")}</p>
          <p className={styles.warningText}>{t("publicShare.noSelectAll")}</p>
        </div>

        <div className={styles.categoryAddGrid}>
          <label className={styles.field} htmlFor="public-share-category">
            <span className={styles.label}>{t("table.category")}</span>
            <select
              id="public-share-category"
              className={styles.select}
              value={selectedCategory}
              disabled={categoryControlsDisabled || availableCategoriesForAdd.length === 0}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                setSelectedCategory(event.target.value);
                setAddMonthlyValuesConfirmed(false);
                setSaved(false);
              }}
            >
              <option value="">-</option>
              {availableCategoriesForAdd.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>

          <label className={styles.field} htmlFor="public-share-access-level">
            <span className={styles.label}>
              {t("publicShare.accessCategoryOnly")} / {t("publicShare.accessMonthlyValues")}
            </span>
            <select
              id="public-share-access-level"
              className={styles.select}
              value={selectedAccessLevel}
              disabled={categoryControlsDisabled}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                setSelectedAccessLevel(event.target.value as MonthlyCategoryShareAccessLevel | "");
                setAddMonthlyValuesConfirmed(false);
                setSaved(false);
              }}
            >
              <option value="">-</option>
              {ACCESS_LEVELS.map((accessLevel) => (
                <option key={accessLevel} value={accessLevel}>{t(getAccessLevelLabelKey(accessLevel))}</option>
              ))}
            </select>
          </label>

          <div className={styles.addAction}>
            <button
              className={settingsStyles.save}
              type="button"
              onClick={() => { void handleAddCategory(); }}
              disabled={!canAddCategory}
            >
              {pendingAction === "items" ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>

        {addingMonthlyValues && (
          <label className={styles.inlineWarning}>
            <input
              type="checkbox"
              checked={addMonthlyValuesConfirmed}
              disabled={categoryControlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                setAddMonthlyValuesConfirmed(event.target.checked);
              }}
            />
            <span>{t("publicShare.upgradeToMonthlyValuesWarning")}</span>
          </label>
        )}

        {settingsDirty && (
          <p className={styles.hint}>{t("publicShare.saveSettingsBeforeCategories")}</p>
        )}

        {response.availableSpendCategories.length === 0 && (
          <p className={styles.mutedText}>{t("settings.noCategories")}</p>
        )}

        {response.selectedItems.length === 0 ? (
          <p className={styles.mutedText}>{t("publicShare.emptyNoSelectedCategories")}</p>
        ) : (
          <div className={styles.itemList}>
            {response.selectedItems.map((item) => {
              const draftAccessLevel = itemAccessDrafts.get(item.category) ?? item.accessLevel;
              const upgradingToMonthlyValues = item.accessLevel === "category_only" && draftAccessLevel === "monthly_values";
              const upgradeConfirmed = upgradeConfirmations.has(item.category);
              const itemDirty = draftAccessLevel !== item.accessLevel;
              const saveDisabled = categoryControlsDisabled || !itemDirty || (upgradingToMonthlyValues && !upgradeConfirmed);

              return (
                <article key={item.category} className={styles.categoryItem}>
                  <div className={styles.categoryItemMain}>
                    <strong className={styles.categoryName}>{item.category}</strong>

                    <select
                      className={styles.select}
                      value={draftAccessLevel}
                      disabled={categoryControlsDisabled}
                      onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                        handleDraftAccessChange(item.category, event.target.value as MonthlyCategoryShareAccessLevel);
                      }}
                    >
                      {ACCESS_LEVELS.map((accessLevel) => (
                        <option key={accessLevel} value={accessLevel}>{t(getAccessLevelLabelKey(accessLevel))}</option>
                      ))}
                    </select>

                    <button
                      className={settingsStyles.save}
                      type="button"
                      onClick={() => { void handleSaveItem(item.category, draftAccessLevel); }}
                      disabled={saveDisabled}
                    >
                      {t("common.save")}
                    </button>

                    <button
                      className={settingsStyles.save}
                      type="button"
                      onClick={() => { void handleRemoveItem(item.category); }}
                      disabled={categoryControlsDisabled}
                    >
                      {t("settings.clear")}
                    </button>
                  </div>

                  {upgradingToMonthlyValues && (
                    <label className={styles.inlineWarning}>
                      <input
                        type="checkbox"
                        checked={upgradeConfirmed}
                        disabled={categoryControlsDisabled}
                        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                          handleUpgradeConfirmationChange(item.category, event.target.checked);
                        }}
                      />
                      <span>{t("publicShare.upgradeToMonthlyValuesWarning")}</span>
                    </label>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {error !== null && <div className={settingsStyles.error}>{error}</div>}
      {saved && <div className={settingsStyles.saved}>{t("common.saved")}</div>}
      {toastMessage !== null && <div className={styles.copyToast}>{toastMessage}</div>}
    </div>
  );
};
