import {
  App,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const FILE_EXPLORER_VIEW_TYPE = "file-explorer";
const STATUS_CLASS = "file-explorer-pin-status";
const MANAGED_EXPLORER_CLASS = "file-explorer-pin-managed";
const ROOT_DROP_PATH_ATTR = "data-fep-root-drop-path";
const ROOT_DROP_ORIGINAL_PATH_ATTR = "data-fep-original-drop-path";
const ROOT_DROP_ORIGINAL_NAME_ATTR = "data-fep-original-name";
const ROOT_DROP_ORIGINAL_TITLE_ATTR = "data-fep-original-title";
const ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR = "data-fep-original-aria-label";
const DEFAULT_TAB_LAYOUT: TabLayout = "grid";
const CONTEXT_INFO_MAX_AGE_MS = 2000;

type TabLayout = "vertical" | "horizontal" | "grid";

interface PluginSettings {
  showGoUpButton: boolean;
  tabLayout: TabLayout;
}

interface PluginData {
  settings: PluginSettings;
  persistedLeaves: Record<string, PersistedLeafState | undefined>;
}

interface FileExplorerViewState {
  sortOrder?: string;
  autoReveal?: boolean;
}

interface ExplorerSnapshot {
  expandedPaths: string[];
  selectedPath: string | null;
  scrollTop: number;
}

interface ExplorerTabState {
  id: string;
  pinnedRootPath: string | null;
  viewSnapshot: ExplorerSnapshot | null;
  restoreSnapshot: ExplorerSnapshot | null;
}

interface PersistedLeafState {
  activeTabId: string;
  tabs: ExplorerTabState[];
}

interface ContextInfo {
  controller: FileExplorerPinController;
  path: string;
  source: "folder-title" | "pinned-root-blank-area";
  at: number;
}

interface InternalExplorerTree {
  focusedItem?: InternalExplorerItem | null;
  setFocusedItem?: (item: InternalExplorerItem | null, focus?: boolean) => void;
}

interface InternalWorkspaceLeaf extends WorkspaceLeaf {
  id: string;
  containerEl?: HTMLElement;
  isVisible?: () => boolean;
}

interface InternalExplorerItem {
  file: TAbstractFile;
  selfEl: HTMLElement;
  setCollapsed?: (collapsed: boolean, animate?: boolean) => Promise<void> | void;
}

interface InternalFileExplorerView {
  app: App;
  containerEl: HTMLElement;
  navFileContainerEl?: HTMLElement;
  fileItems?: Record<string, InternalExplorerItem | undefined>;
  tree?: InternalExplorerTree;
  getSortedFolderItems?: (folder: TFolder) => TAbstractFile[];
  sort?: () => void;
  requestSort?: () => void;
  onFileOpen?: (file: TFile | null) => void;
}

interface PatchedMethods {
  getSortedFolderItems?: (folder: TFolder) => TAbstractFile[];
  onFileOpen?: (file: TFile | null) => void;
}

const DEFAULT_SETTINGS: PluginSettings = {
  showGoUpButton: false,
  tabLayout: DEFAULT_TAB_LAYOUT,
};

export default class FileExplorerPinPlugin extends Plugin {
  private settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private persistedLeaves: Record<string, PersistedLeafState | undefined> = {};
  private readonly controllers = new Map<WorkspaceLeaf, FileExplorerPinController>();
  private readonly pendingObservers = new Map<WorkspaceLeaf, MutationObserver>();
  private lastContextInfo: ContextInfo | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new FileExplorerPinSettingTab(this.app, this));
    this.addCommand({
      id: "open-another-file-explorer",
      name: "Open another explorer",
      callback: async () => {
        await this.openAnotherFileExplorer();
      },
    });

    this.app.workspace.onLayoutReady(() => this.syncControllers());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncControllers()));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (
          source !== "file-explorer-context-menu" ||
          !(file instanceof TFolder)
        ) {
          return;
        }

        const info = this.lastContextInfo;
        if (
          !info ||
          info.path !== file.path ||
          info.source !== "folder-title" ||
          Date.now() - info.at > CONTEXT_INFO_MAX_AGE_MS
        ) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Pin this folder here")
            .setIcon("pin")
            .onClick(() => {
              void info.controller.pin(file.path);
            });
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const controller of this.controllers.values()) {
          controller.handleRename(oldPath, file.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        for (const controller of this.controllers.values()) {
          controller.handleDelete(file.path);
        }
      }),
    );

    this.syncControllers();
  }

  onunload(): void {
    this.lastContextInfo = null;
    for (const observer of this.pendingObservers.values()) {
      observer.disconnect();
    }
    this.pendingObservers.clear();
    for (const controller of this.controllers.values()) {
      controller.detach();
    }
    this.controllers.clear();
  }

  async updateSettings(partial: Partial<PluginSettings>): Promise<void> {
    this.settings = {
      ...this.settings,
      ...partial,
    };
    await this.savePluginData();
    this.syncControllers();
  }

  getPersistedLeafState(leafId: string): PersistedLeafState | null {
    const state = this.persistedLeaves[leafId];
    return state ? clonePersistedLeafState(state) : null;
  }

  async setPersistedLeafState(
    leafId: string,
    state: PersistedLeafState | null,
  ): Promise<void> {
    if (state) {
      this.persistedLeaves[leafId] = clonePersistedLeafState(state);
    } else {
      delete this.persistedLeaves[leafId];
    }

    await this.savePluginData();
  }

  noteContextTarget(
    controller: FileExplorerPinController,
    path: string,
    source: ContextInfo["source"],
  ): void {
    this.lastContextInfo = {
      controller,
      path,
      source,
      at: Date.now(),
    };
  }

  shouldShowGoUpButton(): boolean {
    return this.settings.showGoUpButton;
  }

  getTabLayout(): TabLayout {
    return normalizeTabLayout(this.settings.tabLayout);
  }

  private async openAnotherFileExplorer(): Promise<void> {
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) {
      new Notice("Could not open another file explorer in the left sidebar.");
      return;
    }

    const state = this.getDefaultExplorerState();
    await leaf.setViewState({
      type: FILE_EXPLORER_VIEW_TYPE,
      active: true,
      state: state as Record<string, unknown>,
    });
    await this.app.workspace.revealLeaf(leaf);
    this.syncControllers();
  }

  private syncControllers(): void {
    const activeLeaves = new Set(this.app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE));

    for (const [leaf, controller] of this.controllers.entries()) {
      if (!activeLeaves.has(leaf) || !isLeafVisible(leaf)) {
        controller.detach();
        this.controllers.delete(leaf);
      }
    }

    for (const leaf of Array.from(this.pendingObservers.keys())) {
      if (!activeLeaves.has(leaf)) {
        this.clearPendingObserver(leaf);
      }
    }

    if (this.app.workspace.layoutReady) {
      const activeLeafIds = new Set(Array.from(activeLeaves, (leaf) => getLeafId(leaf)));
      void this.prunePersistedLeaves(activeLeafIds);
    }

    for (const leaf of activeLeaves) {
      const view = leaf.view as InternalFileExplorerView;
      if (!isInternalFileExplorerView(view)) {
        continue;
      }

      const existing = this.controllers.get(leaf);
      if (existing) {
        this.clearPendingObserver(leaf);
        existing.syncUi();
        continue;
      }

      if (!isLeafVisible(leaf) || !view.containerEl.querySelector(".nav-header")) {
        this.waitForExplorerReady(leaf, view);
        continue;
      }

      this.clearPendingObserver(leaf);
      const controller = new FileExplorerPinController(this, leaf, view);
      controller.attach();
      this.controllers.set(leaf, controller);
    }
  }

  private waitForExplorerReady(leaf: WorkspaceLeaf, view: InternalFileExplorerView): void {
    if (this.pendingObservers.has(leaf)) {
      return;
    }

    const observer = new MutationObserver(() => {
      const currentView = leaf.view as InternalFileExplorerView;
      if (
        !isInternalFileExplorerView(currentView) ||
        !isLeafVisible(leaf) ||
        !currentView.containerEl.querySelector(".nav-header")
      ) {
        return;
      }

      this.clearPendingObserver(leaf);
      this.syncControllers();
    });

    for (const target of getExplorerReadinessObserverTargets(
      this.app.workspace.containerEl,
      leaf,
      view,
    )) {
      observer.observe(target, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    }
    this.pendingObservers.set(leaf, observer);
  }

  private clearPendingObserver(leaf: WorkspaceLeaf): void {
    const observer = this.pendingObservers.get(leaf);
    if (!observer) {
      return;
    }

    observer.disconnect();
    this.pendingObservers.delete(leaf);
  }

  private async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    const parsed = parsePluginData(raw);
    this.settings = parsed.settings;
    this.persistedLeaves = parsed.persistedLeaves;
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      persistedLeaves: this.persistedLeaves,
    } satisfies PluginData);
  }

  private async prunePersistedLeaves(activeLeafIds: Set<string>): Promise<void> {
    if (!this.app.workspace.layoutReady) {
      return;
    }

    let changed = false;

    for (const leafId of Object.keys(this.persistedLeaves)) {
      if (activeLeafIds.has(leafId) || this.app.workspace.getLeafById(leafId)) {
        continue;
      }

      delete this.persistedLeaves[leafId];
      changed = true;
    }

    if (changed) {
      await this.savePluginData();
    }
  }

  private getDefaultExplorerState(): FileExplorerViewState {
    for (const leaf of this.app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
      const state = leaf.getViewState().state;
      if (!isRecord(state)) {
        continue;
      }

      const nextState: FileExplorerViewState = {};
      if (typeof state.sortOrder === "string") {
        nextState.sortOrder = state.sortOrder;
      }
      if (typeof state.autoReveal === "boolean") {
        nextState.autoReveal = state.autoReveal;
      }
      return nextState;
    }

    return {};
  }
}

class FileExplorerPinController {
  private readonly plugin: FileExplorerPinPlugin;
  private readonly leaf: WorkspaceLeaf;
  private readonly view: InternalFileExplorerView;
  private readonly rootPath: string;
  private readonly patched: PatchedMethods = {};
  private statusEl: HTMLDivElement | null = null;
  private contextMenuHandler: ((event: MouseEvent) => void) | null = null;
  private interactionHandler: ((event: Event) => void) | null = null;
  private fileDragStartHandler: ((event: DragEvent) => void) | null = null;
  private fileDragEndHandler: ((event: DragEvent) => void) | null = null;
  private fileDropHandler: ((event: DragEvent) => void) | null = null;
  private dragOverlayObserver: MutationObserver | null = null;
  private restoring = false;
  private tabs: ExplorerTabState[] = [];
  private activeTabId: string | null = null;
  private statusRenderKey: string | null = null;
  private snapshotSaveTimer: number | null = null;
  private suppressNextTabClick = false;
  private draggedExplorerPaths: string[] = [];

  constructor(
    plugin: FileExplorerPinPlugin,
    leaf: WorkspaceLeaf,
    view: InternalFileExplorerView,
  ) {
    this.plugin = plugin;
    this.leaf = leaf;
    this.view = view;
    this.rootPath = this.view.app.vault.getRoot().path;
  }

  attach(): void {
    this.hydratePersistedState();
    this.patchView();
    this.view.containerEl.classList.add(MANAGED_EXPLORER_CLASS);
    this.bindContextTracking();
    this.bindInteractionTracking();
    this.bindExplorerDragDrop();
    this.refreshUi();
    void this.restoreCurrentTabView();
  }

  detach(): void {
    if (this.patched.getSortedFolderItems) {
      this.view.getSortedFolderItems = this.patched.getSortedFolderItems;
    }
    if (this.patched.onFileOpen) {
      this.view.onFileOpen = this.patched.onFileOpen;
    }

    if (this.contextMenuHandler) {
      this.view.containerEl.removeEventListener("contextmenu", this.contextMenuHandler, true);
      this.contextMenuHandler = null;
    }
    if (this.interactionHandler) {
      this.view.containerEl.removeEventListener("click", this.interactionHandler, true);
      this.view.containerEl.removeEventListener("scroll", this.interactionHandler, true);
      this.interactionHandler = null;
    }
    if (this.fileDragStartHandler) {
      this.view.containerEl.removeEventListener("dragstart", this.fileDragStartHandler, true);
      this.fileDragStartHandler = null;
    }
    if (this.fileDragEndHandler) {
      this.view.containerEl.removeEventListener("dragend", this.fileDragEndHandler, true);
      this.fileDragEndHandler = null;
    }
    if (this.fileDropHandler) {
      this.view.containerEl.removeEventListener("drop", this.fileDropHandler, true);
      this.fileDropHandler = null;
    }
    if (this.dragOverlayObserver) {
      this.dragOverlayObserver.disconnect();
      this.dragOverlayObserver = null;
    }
    if (this.snapshotSaveTimer !== null) {
      window.clearTimeout(this.snapshotSaveTimer);
      this.snapshotSaveTimer = null;
    }
    this.draggedExplorerPaths = [];

    this.statusEl?.remove();
    this.statusEl = null;
    this.statusRenderKey = null;
    this.restoreRootDisplayState();
    this.view.containerEl.classList.remove(MANAGED_EXPLORER_CLASS);
    this.tabs = [];
    this.activeTabId = null;
  }

  refreshUi(): void {
    this.ensureTabs();
    this.renderStatus();
    this.refreshView();
  }

  syncUi(): void {
    this.ensureTabs();
    this.renderStatus();
    this.syncRootDisplayState();
    this.scheduleRootDisplayStateSync();
  }

  async pin(folderPath: string): Promise<void> {
    const folder = this.getFolder(folderPath);
    if (!folder) {
      new Notice(`Folder not found: ${folderPath}`);
      return;
    }

    if (folder.path === this.rootPath) {
      return;
    }

    const activeTab = this.ensureActiveTab();
    if (activeTab.pinnedRootPath === folder.path) {
      return;
    }

    const currentSnapshot = this.captureNormalizedSnapshotForTab(activeTab);
    if (activeTab.pinnedRootPath === null && activeTab.restoreSnapshot === null) {
      activeTab.restoreSnapshot = cloneExplorerSnapshot(currentSnapshot);
    }
    activeTab.pinnedRootPath = folder.path;
    activeTab.viewSnapshot = this.createSnapshotForRoot(folder.path, currentSnapshot);
    await this.persistState();
    this.renderStatus();
    this.refreshView();
    await this.restoreCurrentTabView();
  }

  async unpin(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (!activeTab || activeTab.pinnedRootPath === null) {
      return;
    }

    const restoreSnapshot = activeTab.restoreSnapshot
      ? cloneExplorerSnapshot(activeTab.restoreSnapshot)
      : createEmptySnapshot();
    activeTab.pinnedRootPath = null;
    activeTab.viewSnapshot = restoreSnapshot;
    activeTab.restoreSnapshot = null;
    await this.persistState();
    this.renderStatus();
    this.refreshView();
    await this.restoreCurrentTabView();
  }

  async goUpOneLevel(): Promise<void> {
    const activeTab = this.getActiveTab();
    if (!activeTab || activeTab.pinnedRootPath === null) {
      return;
    }

    const parentFolder = this.getPinnedParentFolder();
    if (!parentFolder) {
      await this.unpin();
      return;
    }

    if (activeTab.pinnedRootPath === parentFolder.path) {
      return;
    }

    const currentSnapshot = this.captureNormalizedSnapshotForTab(activeTab);
    activeTab.pinnedRootPath = parentFolder.path;
    activeTab.viewSnapshot = this.createSnapshotForRoot(parentFolder.path, currentSnapshot);
    await this.persistState();
    this.renderStatus();
    this.refreshView();
    await this.restoreCurrentTabView();
  }

  handleRename(oldPath: string, newPath: string): void {
    let changed = false;

    for (const tab of this.tabs) {
      if (tab.pinnedRootPath) {
        const rewrittenRoot = rewritePathPrefix(tab.pinnedRootPath, oldPath, newPath);
        if (rewrittenRoot !== tab.pinnedRootPath) {
          tab.pinnedRootPath = rewrittenRoot;
          changed = true;
        }
      }

      if (tab.viewSnapshot) {
        const nextSnapshot = rewriteSnapshotPaths(tab.viewSnapshot, oldPath, newPath);
        if (!areSnapshotsEqual(tab.viewSnapshot, nextSnapshot)) {
          changed = true;
        }
        tab.viewSnapshot = nextSnapshot;
      }

      if (tab.restoreSnapshot) {
        const nextSnapshot = rewriteSnapshotPaths(tab.restoreSnapshot, oldPath, newPath);
        if (!areSnapshotsEqual(tab.restoreSnapshot, nextSnapshot)) {
          changed = true;
        }
        tab.restoreSnapshot = nextSnapshot;
      }
    }

    if (changed) {
      void this.persistState();
    }

    this.renderStatus();
    this.refreshView();
  }

  handleDelete(deletedPath: string): void {
    if (this.tabs.length === 0) {
      return;
    }

    let changed = false;
    for (const tab of this.tabs) {
      if (!tab.pinnedRootPath || !isDescendantPath(tab.pinnedRootPath, deletedPath)) {
        continue;
      }

      tab.pinnedRootPath = null;
      tab.viewSnapshot = tab.restoreSnapshot
        ? cloneExplorerSnapshot(tab.restoreSnapshot)
        : createEmptySnapshot();
      tab.restoreSnapshot = null;
      changed = true;
    }

    if (!changed) {
      return;
    }

    void this.persistState();
    this.renderStatus();
    this.refreshView();
    void this.restoreCurrentTabView();
  }

  private patchView(): void {
    if (typeof this.view.getSortedFolderItems === "function") {
      const original = this.view.getSortedFolderItems.bind(this.view);
      this.patched.getSortedFolderItems = original;
      this.view.getSortedFolderItems = (folder: TFolder) => {
        const pinnedRoot = this.getPinnedRoot();
        if (!pinnedRoot || folder.path !== this.rootPath) {
          return original(folder);
        }

        return original(pinnedRoot);
      };
    }

    if (typeof this.view.onFileOpen === "function") {
      const original = this.view.onFileOpen.bind(this.view);
      this.patched.onFileOpen = original;
      this.view.onFileOpen = (file: TFile | null) => {
        const pinnedRoot = this.getPinnedRoot();
        if (
          pinnedRoot &&
          file &&
          !isDescendantPath(file.path, pinnedRoot.path)
        ) {
          return;
        }

        original(file);
      };
    }
  }

  private hydratePersistedState(): void {
    const persisted = this.plugin.getPersistedLeafState(getLeafId(this.leaf));
    if (!persisted) {
      this.tabs = [createRootTabState()];
      this.activeTabId = this.tabs[0].id;
      return;
    }

    const tabs = persisted.tabs
      .map((tab) => this.sanitizeTabState(tab))
      .filter((tab): tab is ExplorerTabState => tab !== null);

    if (tabs.length === 0) {
      this.tabs = [createRootTabState()];
      this.activeTabId = this.tabs[0].id;
      void this.plugin.setPersistedLeafState(getLeafId(this.leaf), {
        activeTabId: this.activeTabId,
        tabs: this.tabs,
      });
      return;
    }

    this.tabs = tabs;
    this.activeTabId =
      tabs.some((tab) => tab.id === persisted.activeTabId) ? persisted.activeTabId : tabs[0].id;
  }

  private bindContextTracking(): void {
    this.contextMenuHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const titleEl = target.closest<HTMLElement>(".nav-folder-title[data-path]");
      const path = titleEl?.dataset.path;
      const hierarchyRootPath = this.getHierarchyRootPath();
      if (titleEl && path === this.rootPath && hierarchyRootPath !== this.rootPath) {
        const folder = this.getFolder(hierarchyRootPath);
        if (!folder) {
          return;
        }

        this.plugin.noteContextTarget(this, folder.path, "pinned-root-blank-area");
        event.preventDefault();
        event.stopImmediatePropagation();
        this.showNativeFolderMenu(event, folder);
        return;
      }

      if (!path) {
        if (getExplorerItemPathFromElement(target) !== null) {
          return;
        }

        const containerEl = target.closest<HTMLElement>(".nav-files-container");
        if (!containerEl || hierarchyRootPath === this.rootPath) {
          return;
        }

        const folder = this.getFolder(hierarchyRootPath);
        if (!folder) {
          return;
        }

        this.plugin.noteContextTarget(this, folder.path, "pinned-root-blank-area");
        event.preventDefault();
        event.stopImmediatePropagation();
        this.showNativeFolderMenu(event, folder);
        return;
      }

      this.plugin.noteContextTarget(this, path, "folder-title");
    };

    this.view.containerEl.addEventListener("contextmenu", this.contextMenuHandler, true);
  }

  private showNativeFolderMenu(event: MouseEvent, folder: TFolder): void {
    const menu = new Menu();
    this.view.app.workspace.trigger("file-menu", menu, folder, "file-explorer-context-menu");
    menu.showAtMouseEvent(event);
  }

  private bindInteractionTracking(): void {
    this.interactionHandler = () => {
      this.scheduleActiveTabSnapshotSave();
    };

    this.view.containerEl.addEventListener("click", this.interactionHandler, true);
    this.view.containerEl.addEventListener("scroll", this.interactionHandler, true);
  }

  private bindExplorerDragDrop(): void {
    if (this.fileDragStartHandler || this.fileDragEndHandler || this.fileDropHandler) {
      return;
    }

    this.fileDragStartHandler = (event: DragEvent) => {
      this.draggedExplorerPaths = this.getDraggedExplorerPathsFromEventTarget(event.target);
      this.startDragOverlayObserver();
    };
    this.fileDragEndHandler = () => {
      this.draggedExplorerPaths = [];
      this.stopDragOverlayObserver();
    };
    this.fileDropHandler = (event: DragEvent) => {
      void this.handleExplorerDrop(event);
    };

    this.view.containerEl.addEventListener("dragstart", this.fileDragStartHandler, true);
    this.view.containerEl.addEventListener("dragend", this.fileDragEndHandler, true);
    this.view.containerEl.addEventListener("drop", this.fileDropHandler, true);
  }

  private getDraggedExplorerPathsFromEventTarget(target: EventTarget | null): string[] {
    if (!(target instanceof HTMLElement)) {
      return [];
    }

    const sourcePath = getExplorerItemPathFromElement(target);
    if (!sourcePath) {
      return [];
    }

    const selectedPaths = Array.from(
      this.view.containerEl.querySelectorAll<HTMLElement>(
        ".nav-file-title.is-selected[data-path], .nav-folder-title.is-selected[data-path]",
      ),
    )
      .map((element) => element.dataset.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0);

    if (selectedPaths.includes(sourcePath)) {
      return uniquePaths(selectedPaths);
    }

    return [sourcePath];
  }

  private async handleExplorerDrop(event: DragEvent): Promise<void> {
    if (this.draggedExplorerPaths.length === 0) {
      return;
    }

    const activeRootPath = this.getHierarchyRootPath();
    if (activeRootPath === this.rootPath) {
      return;
    }

    const targetPath = getExplorerItemPathFromElement(event.target);
    if (targetPath !== null && targetPath !== this.rootPath) {
      return;
    }

    const targetFolder = this.getFolder(activeRootPath);
    if (!targetFolder) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    try {
      await this.moveDraggedExplorerItems(targetFolder.path);
    } finally {
      this.draggedExplorerPaths = [];
      this.stopDragOverlayObserver();
    }
  }

  private startDragOverlayObserver(): void {
    const pinnedRoot = this.getPinnedRoot();
    if (!pinnedRoot || pinnedRoot.path === this.rootPath) {
      this.stopDragOverlayObserver();
      return;
    }

    if (!this.dragOverlayObserver) {
      this.dragOverlayObserver = new MutationObserver((mutations) => {
        this.syncDragOverlayRootName(mutations);
      });
      this.dragOverlayObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    this.syncDragOverlayRootName();
  }

  private stopDragOverlayObserver(): void {
    if (!this.dragOverlayObserver) {
      return;
    }

    this.dragOverlayObserver.disconnect();
    this.dragOverlayObserver = null;
  }

  private syncDragOverlayRootName(mutations?: MutationRecord[]): void {
    const pinnedRoot = this.getPinnedRoot();
    if (!pinnedRoot || pinnedRoot.path === this.rootPath) {
      return;
    }

    const rootName = this.view.app.vault.getRoot().name;
    if (!rootName || rootName === pinnedRoot.name) {
      return;
    }

    if (!mutations || mutations.length === 0) {
      replaceRootNameInFloatingNodes(document.body, rootName, pinnedRoot.name, this.view.containerEl);
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        replaceRootNameInFloatingNodes(mutation.target, rootName, pinnedRoot.name, this.view.containerEl);
        continue;
      }

      for (const node of Array.from(mutation.addedNodes)) {
        replaceRootNameInFloatingNodes(node, rootName, pinnedRoot.name, this.view.containerEl);
      }
    }
  }

  private syncRootDisplayState(): void {
    this.restoreLegacyRootDropPaths();

    const pinnedRoot = this.getPinnedRoot();
    if (!pinnedRoot) {
      this.restoreRootDisplayNames();
      return;
    }

    const rootItem = this.view.fileItems?.[this.rootPath] ?? null;
    for (const element of this.getRootDisplayNameElements(rootItem)) {
      overrideRootDisplayName(element, pinnedRoot.name);
    }
  }

  private restoreRootDisplayState(): void {
    this.restoreLegacyRootDropPaths();
    this.restoreRootDisplayNames();
  }

  private restoreLegacyRootDropPaths(): void {
    for (const element of Array.from(
      this.view.containerEl.querySelectorAll<HTMLElement>(
        `[${ROOT_DROP_PATH_ATTR}], [${ROOT_DROP_ORIGINAL_PATH_ATTR}]`,
      ),
    )) {
      restoreRootDropPath(element);
    }
  }

  private restoreRootDisplayNames(): void {
    for (const element of Array.from(
      this.view.containerEl.querySelectorAll<HTMLElement>(
        `[${ROOT_DROP_ORIGINAL_NAME_ATTR}], [${ROOT_DROP_ORIGINAL_TITLE_ATTR}], [${ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR}]`,
      ),
    )) {
      restoreRootDisplayName(element);
    }
  }

  private getRootDisplayNameElements(rootItem: InternalExplorerItem | null): HTMLElement[] {
    const elements = new Set<HTMLElement>();

    if (rootItem?.selfEl) {
      for (const selector of [".nav-folder-title-content", ".tree-item-inner"]) {
        const element = rootItem.selfEl.matches(selector)
          ? rootItem.selfEl
          : rootItem.selfEl.querySelector<HTMLElement>(selector);
        if (element) {
          elements.add(element);
        }
      }
    }

    for (const selector of [
      ".nav-folder.mod-root > .nav-folder-title .nav-folder-title-content",
      ".tree-item-self.mod-root .tree-item-inner",
    ]) {
      for (const element of Array.from(this.view.containerEl.querySelectorAll<HTMLElement>(selector))) {
        elements.add(element);
      }
    }

    return Array.from(elements);
  }

  private async moveDraggedExplorerItems(targetFolderPath: string): Promise<void> {
    for (const path of uniquePaths(this.draggedExplorerPaths)) {
      const file = this.view.app.vault.getAbstractFileByPath(path);
      if (!file) {
        continue;
      }

      if (getParentPath(path) === targetFolderPath) {
        continue;
      }

      if (
        file instanceof TFolder &&
        targetFolderPath !== file.path &&
        isDescendantPath(targetFolderPath, file.path)
      ) {
        new Notice(`Cannot move folder into itself: ${file.name}`);
        continue;
      }

      const nextPath = joinVaultPath(targetFolderPath, file.name);
      if (file.path === nextPath) {
        continue;
      }

      try {
        await this.view.app.fileManager.renameFile(file, nextPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Failed to move ${file.name}: ${message}`);
      }
    }
  }

  private renderStatus(): void {
    const headerEl = this.view.containerEl.querySelector<HTMLElement>(".nav-header");
    if (!headerEl) {
      this.statusEl?.remove();
      this.statusEl = null;
      this.statusRenderKey = null;
      return;
    }

    this.ensureTabs();

    if (!this.statusEl) {
      const existingStatusEl = this.view.containerEl.querySelector<HTMLDivElement>(`.${STATUS_CLASS}`);
      this.statusEl =
        existingStatusEl ??
        createDiv({
          cls: STATUS_CLASS,
        });
    }

    this.statusEl.dataset.layout = this.plugin.getTabLayout();
    const nextRenderKey = this.getStatusRenderKey();
    const shouldRender =
      this.statusRenderKey !== nextRenderKey || this.statusEl.childElementCount === 0;
    if (shouldRender) {
      const fragment = document.createDocumentFragment();
      for (const tab of this.tabs) {
        fragment.appendChild(this.createTabElement(tab));
      }
      fragment.appendChild(this.createAddTabElement());
      this.statusEl.replaceChildren(fragment);
      this.statusRenderKey = nextRenderKey;
    }

    if (this.statusEl.parentElement !== headerEl.parentElement) {
      headerEl.insertAdjacentElement("afterend", this.statusEl);
    } else if (headerEl.nextElementSibling !== this.statusEl) {
      headerEl.insertAdjacentElement("afterend", this.statusEl);
    }
    if (shouldRender) {
      this.scrollActiveTabIntoView();
    }
  }

  private getStatusRenderKey(): string {
    return JSON.stringify({
      layout: this.plugin.getTabLayout(),
      showGoUpButton: this.plugin.shouldShowGoUpButton(),
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        pinnedRootPath: tab.pinnedRootPath,
        label: this.getTabLabel(tab),
        title: this.getTabTitle(tab),
        parentPath: this.getParentFolderForTab(tab)?.path ?? null,
      })),
    });
  }

  private syncStatusActiveState(): void {
    if (!this.statusEl) {
      return;
    }

    for (const tabEl of Array.from(
      this.statusEl.querySelectorAll<HTMLElement>(".file-explorer-pin-tab[data-tab-id]"),
    )) {
      tabEl.classList.toggle("is-active", tabEl.dataset.tabId === this.activeTabId);
    }

    this.scrollActiveTabIntoView();
  }

  private refreshView(): void {
    this.syncRootDisplayState();

    if (typeof this.view.requestSort === "function") {
      this.view.requestSort();
      this.scheduleRootDisplayStateSync();
      return;
    }

    if (typeof this.view.sort === "function") {
      this.view.sort();
    }

    this.scheduleRootDisplayStateSync();
  }

  private scheduleRootDisplayStateSync(): void {
    window.requestAnimationFrame(() => {
      this.syncRootDisplayState();
    });
  }

  private captureSnapshot(): ExplorerSnapshot {
    return {
      expandedPaths: this.getExpandedPaths(),
      selectedPath: this.getSelectedPath(),
      scrollTop: this.getScrollContainer()?.scrollTop ?? 0,
    };
  }

  private async restoreSnapshotState(snapshot: ExplorerSnapshot): Promise<void> {
    if (this.restoring) {
      return;
    }

    this.restoring = true;
    try {
      await waitForNextFrame();
      const paths = snapshot.expandedPaths
        .filter((path) => path !== this.rootPath)
        .filter((path) => this.view.app.vault.getAbstractFileByPath(path) instanceof TFolder)
        .sort(comparePathDepthAscending);

      for (const path of paths) {
        const item = this.view.fileItems?.[path];
        if (!item || typeof item.setCollapsed !== "function") {
          continue;
        }

        await Promise.resolve(item.setCollapsed(false, false));
      }

      await waitForNextFrame();
      this.restoreSelection(snapshot.selectedPath);

      const scrollContainer = this.getScrollContainer();
      if (scrollContainer) {
        scrollContainer.scrollTop = snapshot.scrollTop;
      }
    } finally {
      this.restoring = false;
    }
  }

  private restoreSelection(path: string | null): void {
    if (!path) {
      return;
    }

    const item = this.view.fileItems?.[path];
    if (!item) {
      return;
    }

    const tree = this.view.tree;
    if (typeof tree?.setFocusedItem === "function") {
      tree.setFocusedItem(item, false);
    }

    item.selfEl.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }

  private getExpandedPaths(): string[] {
    const paths: string[] = [];
    const folderTitles = this.view.containerEl.querySelectorAll<HTMLElement>(
      ".nav-folder-title[data-path]",
    );

    folderTitles.forEach((titleEl) => {
      const path = titleEl.dataset.path;
      if (!path) {
        return;
      }

      const folderEl = titleEl.closest(".nav-folder");
      if (!folderEl || folderEl.classList.contains("is-collapsed")) {
        return;
      }

      paths.push(path);
    });

    return paths;
  }

  private getSelectedPath(): string | null {
    const selectedEl =
      this.view.containerEl.querySelector<HTMLElement>(
        ".tree-item-self.has-focus[data-path]",
      ) ??
      this.view.containerEl.querySelector<HTMLElement>(
        ".nav-file-title.is-active[data-path], .nav-folder-title.is-active[data-path]",
      ) ??
      this.view.containerEl.querySelector<HTMLElement>(
        ".nav-file-title.is-selected[data-path], .nav-folder-title.is-selected[data-path]",
      );

    return selectedEl?.dataset.path ?? this.view.tree?.focusedItem?.file.path ?? null;
  }

  private getScrollContainer(): HTMLElement | null {
    return this.view.navFileContainerEl ?? this.view.containerEl.querySelector(".nav-files-container");
  }

  private getHierarchyRootPath(): string {
    return this.getActiveTab()?.pinnedRootPath ?? this.rootPath;
  }

  private getPinnedRoot(): TFolder | null {
    const activeTab = this.getActiveTab();
    if (!activeTab?.pinnedRootPath) {
      return null;
    }

    return this.getFolder(activeTab.pinnedRootPath);
  }

  private getPinnedParentFolder(): TFolder | null {
    const activeTab = this.getActiveTab();
    if (!activeTab?.pinnedRootPath) {
      return null;
    }

    const parentPath = getPinnedParentFolderPath(activeTab.pinnedRootPath, this.rootPath);
    return parentPath ? this.getFolder(parentPath) : null;
  }

  private getFolder(path: string): TFolder | null {
    if (path === this.rootPath) {
      return this.view.app.vault.getRoot();
    }

    const file = this.view.app.vault.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
  }

  private async persistState(): Promise<void> {
    if (this.tabs.length === 0 || this.activeTabId === null) {
      await this.plugin.setPersistedLeafState(getLeafId(this.leaf), null);
      return;
    }

    await this.plugin.setPersistedLeafState(getLeafId(this.leaf), {
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => cloneExplorerTabState(tab)),
    });
  }

  private createTabElement(tab: ExplorerTabState): HTMLDivElement {
    const tabEl = createDiv({
      cls: "file-explorer-pin-tab",
    });
    tabEl.dataset.tabId = tab.id;
    tabEl.classList.toggle("is-active", tab.id === this.activeTabId);
    tabEl.setAttribute("role", "button");
    tabEl.tabIndex = 0;
    tabEl.setAttribute("aria-label", this.getTabTitle(tab));
    tabEl.addEventListener("click", (event) => {
      if (this.suppressNextTabClick) {
        this.suppressNextTabClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      void this.activateTab(tab.id);
    });
    tabEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      void this.activateTab(tab.id);
    });

    const bodyEl = tabEl.createDiv({
      cls: "file-explorer-pin-tab-body",
    });
    bodyEl.createSpan({
      cls: "file-explorer-pin-tab-label",
      text: this.getTabLabel(tab),
    });

    if (this.plugin.shouldShowGoUpButton()) {
      const parentFolder = this.getParentFolderForTab(tab);
      const upButton = tabEl.createEl("button", {
        cls: "file-explorer-pin-tab-action",
        attr: {
          type: "button",
          "aria-label": parentFolder ? "Go up one level" : "Already at top level",
        },
      });
      setIcon(upButton, "corner-up-left");
      upButton.disabled = tab.pinnedRootPath === null;
      upButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.activateTab(tab.id, async () => this.goUpOneLevel());
      });
    }

    const rootTab = tab.pinnedRootPath === null;
    const pinOrCloseButton = tabEl.createEl("button", {
      cls: "file-explorer-pin-tab-action",
      attr: {
        type: "button",
        "aria-label": rootTab ? "Close tab" : "Unpin current folder",
      },
    });
    setIcon(pinOrCloseButton, rootTab ? "x" : "pin");
    pinOrCloseButton.classList.toggle("is-active", !rootTab);
    pinOrCloseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (rootTab) {
        void this.closeTab(tab.id);
      } else {
        void this.activateTab(tab.id, async () => this.unpin());
      }
    });

    return tabEl;
  }

  private createAddTabElement(): HTMLButtonElement {
    const buttonEl = createEl("button", {
      cls: "file-explorer-pin-add-tab",
      attr: {
        type: "button",
        "aria-label": "Add root tab",
      },
    });
    setIcon(buttonEl, "plus");
    buttonEl.addEventListener("click", () => {
      void this.addRootTab();
    });
    return buttonEl;
  }

  private async addRootTab(): Promise<void> {
    this.saveActiveTabViewSnapshot();
    const nextTab = createRootTabState();
    this.tabs.push(nextTab);
    this.activeTabId = nextTab.id;
    await this.persistState();
    this.renderStatus();
    this.refreshView();
    await this.restoreCurrentTabView();
  }

  private async activateTab(
    tabId: string,
    whenActivated?: () => Promise<void> | void,
  ): Promise<void> {
    if (this.activeTabId !== tabId) {
      this.saveActiveTabViewSnapshot();
      this.activeTabId = tabId;
      await this.persistState();
      this.syncStatusActiveState();
      this.refreshView();
      await this.restoreCurrentTabView();
    }

    if (whenActivated) {
      await whenActivated();
    }
  }

  private async closeTab(tabId: string): Promise<void> {
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex < 0) {
      return;
    }

    const isActive = this.activeTabId === tabId;
    if (isActive) {
      this.saveActiveTabViewSnapshot();
    }

    if (this.tabs.length === 1) {
      await this.plugin.setPersistedLeafState(getLeafId(this.leaf), null);
      this.leaf.detach();
      return;
    }

    this.tabs.splice(tabIndex, 1);
    if (isActive) {
      const fallbackTab = this.tabs[tabIndex] ?? this.tabs[tabIndex - 1] ?? this.tabs[0];
      this.activeTabId = fallbackTab?.id ?? null;
    }

    await this.persistState();
    this.renderStatus();
    this.refreshView();
    if (isActive) {
      await this.restoreCurrentTabView();
    }
  }

  private async restoreCurrentTabView(): Promise<void> {
    const activeTab = this.ensureActiveTab();
    const snapshot = activeTab.viewSnapshot ?? createEmptySnapshot();
    await this.restoreSnapshotState(snapshot);
  }

  private scrollActiveTabIntoView(): void {
    window.requestAnimationFrame(() => {
      if (!this.statusEl || this.activeTabId === null) {
        return;
      }

      const activeTabEl = this.statusEl.querySelector<HTMLElement>(
        `.file-explorer-pin-tab[data-tab-id="${CSS.escape(this.activeTabId)}"]`,
      );
      if (!activeTabEl) {
        return;
      }

      activeTabEl.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    });
  }

  private saveActiveTabViewSnapshot(): void {
    const activeTab = this.getActiveTab();
    if (!activeTab) {
      return;
    }

    activeTab.viewSnapshot = this.captureNormalizedSnapshotForTab(activeTab);
  }

  private scheduleActiveTabSnapshotSave(): void {
    if (this.restoring) {
      return;
    }

    if (this.snapshotSaveTimer !== null) {
      window.clearTimeout(this.snapshotSaveTimer);
    }

    this.snapshotSaveTimer = window.setTimeout(() => {
      this.snapshotSaveTimer = null;
      this.saveActiveTabViewSnapshot();
      void this.persistState();
    }, 120);
  }

  private ensureTabs(): void {
    if (this.tabs.length > 0) {
      if (this.activeTabId === null || !this.tabs.some((tab) => tab.id === this.activeTabId)) {
        this.activeTabId = this.tabs[0].id;
      }
      return;
    }

    const rootTab = createRootTabState();
    this.tabs = [rootTab];
    this.activeTabId = rootTab.id;
  }

  private ensureActiveTab(): ExplorerTabState {
    this.ensureTabs();
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? this.tabs[0];
  }

  private getActiveTab(): ExplorerTabState | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private getTabLabel(tab: ExplorerTabState): string {
    if (!tab.pinnedRootPath) {
      return "Top level";
    }

    return this.getFolder(tab.pinnedRootPath)?.name ?? tab.pinnedRootPath;
  }

  private getTabTitle(tab: ExplorerTabState): string {
    return tab.pinnedRootPath ?? this.rootPath;
  }

  private getParentFolderForTab(tab: ExplorerTabState): TFolder | null {
    if (!tab.pinnedRootPath) {
      return null;
    }

    const parentPath = getPinnedParentFolderPath(tab.pinnedRootPath, this.rootPath);
    return parentPath ? this.getFolder(parentPath) : null;
  }

  private sanitizeTabState(tab: ExplorerTabState): ExplorerTabState | null {
    if (tab.pinnedRootPath !== null) {
      const folder = this.getFolder(tab.pinnedRootPath);
      if (!folder || folder.path === this.rootPath) {
        return createRootTabState(
          tab.id,
          tab.viewSnapshot ? this.createSnapshotForRoot(this.rootPath, tab.viewSnapshot) : createEmptySnapshot(),
          null,
        );
      }

      return {
        id: tab.id,
        pinnedRootPath: folder.path,
        viewSnapshot: tab.viewSnapshot
          ? this.createSnapshotForRoot(folder.path, tab.viewSnapshot)
          : createEmptySnapshot(),
        restoreSnapshot: tab.restoreSnapshot
          ? this.createSnapshotForRoot(this.rootPath, tab.restoreSnapshot)
          : null,
      };
    }

    return {
      id: tab.id,
      pinnedRootPath: null,
      viewSnapshot: tab.viewSnapshot ? this.createSnapshotForRoot(this.rootPath, tab.viewSnapshot) : null,
      restoreSnapshot: null,
    };
  }

  private captureNormalizedSnapshotForTab(tab: ExplorerTabState): ExplorerSnapshot {
    const rootPath = tab.pinnedRootPath ?? this.rootPath;
    return this.createSnapshotForRoot(rootPath, this.captureSnapshot());
  }

  private createSnapshotForRoot(rootPath: string, snapshot: ExplorerSnapshot): ExplorerSnapshot {
    const expandedPaths = snapshot.expandedPaths.filter((path, index, paths) => {
      return (
        path !== rootPath &&
        isDescendantPath(path, rootPath) &&
        this.getFolder(path) !== null &&
        paths.indexOf(path) === index
      );
    });

    const selectedPath =
      snapshot.selectedPath !== null &&
      snapshot.selectedPath !== rootPath &&
      isDescendantPath(snapshot.selectedPath, rootPath) &&
      this.view.app.vault.getAbstractFileByPath(snapshot.selectedPath)
        ? snapshot.selectedPath
        : null;

    return {
      expandedPaths,
      selectedPath,
      scrollTop: Math.max(0, snapshot.scrollTop),
    };
  }
}

class FileExplorerPinSettingTab extends PluginSettingTab {
  private readonly plugin: FileExplorerPinPlugin;

  constructor(app: App, plugin: FileExplorerPinPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show \"go up one level\" button")
      .setDesc("Show the parent-folder button on each pinned tab.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.shouldShowGoUpButton());
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({
            showGoUpButton: value,
          });
        });
      });

    new Setting(containerEl)
      .setName("Tab layout")
      .setDesc("Choose how pinned tabs are arranged.")
      .addDropdown((dropdown) => {
        dropdown.addOption("grid", "Grid (2 columns)");
        dropdown.addOption("vertical", "Vertical");
        dropdown.addOption("horizontal", "Horizontal");
        dropdown.setValue(this.plugin.getTabLayout());
        dropdown.onChange(async (value) => {
          if (!isTabLayout(value)) {
            return;
          }

          await this.plugin.updateSettings({
            tabLayout: value,
          });
        });
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTabLayout(value: unknown): value is TabLayout {
  return value === "vertical" || value === "horizontal" || value === "grid";
}

function normalizeTabLayout(value: unknown): TabLayout {
  return isTabLayout(value) ? value : DEFAULT_TAB_LAYOUT;
}

function isInternalFileExplorerView(view: unknown): view is InternalFileExplorerView {
  if (!isRecord(view)) {
    return false;
  }

  return view.containerEl instanceof HTMLElement;
}

function isLeafVisible(leaf: WorkspaceLeaf): boolean {
  const internalLeaf = leaf as unknown as InternalWorkspaceLeaf;
  if (typeof internalLeaf.isVisible === "function") {
    return internalLeaf.isVisible();
  }

  if (internalLeaf.containerEl instanceof HTMLElement) {
    return internalLeaf.containerEl.getClientRects().length > 0;
  }

  return true;
}

function getExplorerReadinessObserverTargets(
  workspaceEl: HTMLElement,
  leaf: WorkspaceLeaf,
  view: InternalFileExplorerView,
): HTMLElement[] {
  const targets = new Set<HTMLElement>([workspaceEl, view.containerEl]);
  const internalLeaf = leaf as unknown as InternalWorkspaceLeaf;

  if (internalLeaf.containerEl instanceof HTMLElement) {
    targets.add(internalLeaf.containerEl);
  }

  const root = leaf.getRoot() as unknown as { containerEl?: HTMLElement };
  if (root?.containerEl instanceof HTMLElement) {
    targets.add(root.containerEl);
  }

  return Array.from(targets);
}

function isDescendantPath(path: string, rootPath: string): boolean {
  if (rootPath.length === 0) {
    return true;
  }

  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function rewritePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) {
    return newPath;
  }

  if (!isDescendantPath(path, oldPath)) {
    return path;
  }

  return `${newPath}${path.slice(oldPath.length)}`;
}

function getPinnedParentFolderPath(path: string, rootPath: string): string | null {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) {
    return null;
  }

  const parentPath = path.slice(0, separatorIndex);
  if (!parentPath || parentPath === rootPath) {
    return null;
  }

  return parentPath;
}

function comparePathDepthAscending(left: string, right: string): number {
  const leftDepth = left.split("/").length;
  const rightDepth = right.split("/").length;
  return leftDepth - rightDepth || left.localeCompare(right);
}

function cloneExplorerSnapshot(snapshot: ExplorerSnapshot): ExplorerSnapshot {
  return {
    expandedPaths: [...snapshot.expandedPaths],
    selectedPath: snapshot.selectedPath,
    scrollTop: snapshot.scrollTop,
  };
}

function clonePersistedLeafState(state: PersistedLeafState): PersistedLeafState {
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => cloneExplorerTabState(tab)),
  };
}

function cloneExplorerTabState(tab: ExplorerTabState): ExplorerTabState {
  return {
    id: tab.id,
    pinnedRootPath: tab.pinnedRootPath,
    viewSnapshot: tab.viewSnapshot ? cloneExplorerSnapshot(tab.viewSnapshot) : null,
    restoreSnapshot: tab.restoreSnapshot ? cloneExplorerSnapshot(tab.restoreSnapshot) : null,
  };
}

function areSnapshotsEqual(left: ExplorerSnapshot, right: ExplorerSnapshot): boolean {
  if (left.selectedPath !== right.selectedPath || left.scrollTop !== right.scrollTop) {
    return false;
  }

  if (left.expandedPaths.length !== right.expandedPaths.length) {
    return false;
  }

  return left.expandedPaths.every((path, index) => path === right.expandedPaths[index]);
}

function getExplorerItemPathFromElement(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const pathOwner = target.closest<HTMLElement>(
    ".nav-file-title[data-path], .nav-folder-title[data-path], .tree-item-self[data-path]",
  );
  const path = pathOwner?.dataset.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function getParentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) {
    return "";
  }

  return path.slice(0, separatorIndex);
}

function joinVaultPath(parentPath: string, childName: string): string {
  return parentPath.length > 0 ? `${parentPath}/${childName}` : childName;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function restoreRootDropPath(element: HTMLElement): void {
  const originalPath = element.getAttribute(ROOT_DROP_ORIGINAL_PATH_ATTR);
  if (originalPath !== null) {
    element.setAttribute("data-path", originalPath);
    element.removeAttribute(ROOT_DROP_ORIGINAL_PATH_ATTR);
  } else if (element.hasAttribute(ROOT_DROP_PATH_ATTR)) {
    element.removeAttribute("data-path");
  }

  element.removeAttribute(ROOT_DROP_PATH_ATTR);
}

function overrideRootDisplayName(element: HTMLElement, name: string): void {
  if (!element.hasAttribute(ROOT_DROP_ORIGINAL_NAME_ATTR)) {
    element.setAttribute(ROOT_DROP_ORIGINAL_NAME_ATTR, element.textContent ?? "");
  }

  if (!element.hasAttribute(ROOT_DROP_ORIGINAL_TITLE_ATTR)) {
    const originalTitle = element.getAttribute("title");
    if (originalTitle !== null) {
      element.setAttribute(ROOT_DROP_ORIGINAL_TITLE_ATTR, originalTitle);
    }
  }

  if (!element.hasAttribute(ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR)) {
    const originalAriaLabel = element.getAttribute("aria-label");
    if (originalAriaLabel !== null) {
      element.setAttribute(ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR, originalAriaLabel);
    }
  }

  element.textContent = name;
  element.setAttribute("title", name);
  element.setAttribute("aria-label", name);
}

function restoreRootDisplayName(element: HTMLElement): void {
  const originalName = element.getAttribute(ROOT_DROP_ORIGINAL_NAME_ATTR);
  if (originalName !== null) {
    element.textContent = originalName;
    element.removeAttribute(ROOT_DROP_ORIGINAL_NAME_ATTR);
  }

  const originalTitle = element.getAttribute(ROOT_DROP_ORIGINAL_TITLE_ATTR);
  if (originalTitle !== null) {
    element.setAttribute("title", originalTitle);
    element.removeAttribute(ROOT_DROP_ORIGINAL_TITLE_ATTR);
  } else {
    element.removeAttribute("title");
  }

  const originalAriaLabel = element.getAttribute(ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR);
  if (originalAriaLabel !== null) {
    element.setAttribute("aria-label", originalAriaLabel);
    element.removeAttribute(ROOT_DROP_ORIGINAL_ARIA_LABEL_ATTR);
  } else {
    element.removeAttribute("aria-label");
  }
}

function replaceRootNameInFloatingNodes(
  root: Node,
  rootName: string,
  pinnedRootName: string,
  explorerContainer: HTMLElement,
): void {
  const textNodes = collectTextNodes(root);
  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent || explorerContainer.contains(parent)) {
      continue;
    }

    const value = textNode.nodeValue;
    if (!value || !value.includes(rootName)) {
      continue;
    }

    const host = parent.closest<HTMLElement>("body *");
    if (!host || explorerContainer.contains(host) || !isFloatingElement(host)) {
      continue;
    }

    textNode.nodeValue = value.split(rootName).join(pinnedRootName);
  }
}

function collectTextNodes(root: Node): Text[] {
  if (root.nodeType === Node.TEXT_NODE) {
    return root instanceof Text ? [root] : [];
  }

  if (!(root instanceof Element || root instanceof DocumentFragment || root instanceof Document)) {
    return [];
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  return textNodes;
}

function isFloatingElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    style.position === "fixed" ||
    style.position === "absolute" ||
    element.getAttribute("role") === "tooltip"
  );
}

function parsePluginData(raw: unknown): PluginData {
  if (!isRecord(raw)) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      persistedLeaves: {},
    };
  }

  const settingsSource = isRecord(raw.settings) ? raw.settings : raw;
  const settings: PluginSettings = {
    showGoUpButton:
      typeof settingsSource.showGoUpButton === "boolean"
        ? settingsSource.showGoUpButton
        : DEFAULT_SETTINGS.showGoUpButton,
    tabLayout: normalizeTabLayout(settingsSource.tabLayout),
  };

  const persistedLeaves: Record<string, PersistedLeafState | undefined> = {};
  if (isRecord(raw.persistedLeaves)) {
    for (const [leafId, value] of Object.entries(raw.persistedLeaves)) {
      const parsed = parsePersistedLeafState(value);
      if (parsed) {
        persistedLeaves[leafId] = parsed;
      }
    }
  }

  return {
    settings,
    persistedLeaves,
  };
}

function parsePersistedLeafState(value: unknown): PersistedLeafState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (Array.isArray(value.tabs) && typeof value.activeTabId === "string") {
    const tabs = value.tabs
      .map((tab) => parseExplorerTabState(tab))
      .filter((tab): tab is ExplorerTabState => tab !== null);
    if (tabs.length === 0) {
      return null;
    }

    return {
      activeTabId: tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : tabs[0].id,
      tabs,
    };
  }

  if (typeof value.pinnedRootPath !== "string") {
    return null;
  }

  const migratedTab = createPinnedTabState(
    value.pinnedRootPath,
    null,
    parseExplorerSnapshot(value.restoreSnapshot),
  );
  return {
    activeTabId: migratedTab.id,
    tabs: [migratedTab],
  };
}

function parseExplorerTabState(value: unknown): ExplorerTabState | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  const pinnedRootPath =
    value.pinnedRootPath === null
      ? null
      : typeof value.pinnedRootPath === "string"
        ? value.pinnedRootPath
        : null;

  return {
    id: value.id,
    pinnedRootPath,
    viewSnapshot: parseExplorerSnapshot(value.viewSnapshot),
    restoreSnapshot: parseExplorerSnapshot(value.restoreSnapshot),
  };
}

function parseExplorerSnapshot(value: unknown): ExplorerSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    expandedPaths: Array.isArray(value.expandedPaths)
      ? value.expandedPaths.filter((path): path is string => typeof path === "string")
      : [],
    selectedPath: typeof value.selectedPath === "string" ? value.selectedPath : null,
    scrollTop: typeof value.scrollTop === "number" ? value.scrollTop : 0,
  };
}

function createEmptySnapshot(): ExplorerSnapshot {
  return {
    expandedPaths: [],
    selectedPath: null,
    scrollTop: 0,
  };
}

function createRootTabState(
  id: string = generateTabId(),
  viewSnapshot: ExplorerSnapshot | null = createEmptySnapshot(),
  restoreSnapshot: ExplorerSnapshot | null = null,
): ExplorerTabState {
  return {
    id,
    pinnedRootPath: null,
    viewSnapshot: viewSnapshot ? cloneExplorerSnapshot(viewSnapshot) : null,
    restoreSnapshot: restoreSnapshot ? cloneExplorerSnapshot(restoreSnapshot) : null,
  };
}

function createPinnedTabState(
  pinnedRootPath: string,
  viewSnapshot: ExplorerSnapshot | null = null,
  restoreSnapshot: ExplorerSnapshot | null = null,
  id: string = generateTabId(),
): ExplorerTabState {
  return {
    id,
    pinnedRootPath,
    viewSnapshot: viewSnapshot ? cloneExplorerSnapshot(viewSnapshot) : null,
    restoreSnapshot: restoreSnapshot ? cloneExplorerSnapshot(restoreSnapshot) : null,
  };
}

function rewriteSnapshotPaths(
  snapshot: ExplorerSnapshot,
  oldPath: string,
  newPath: string,
): ExplorerSnapshot {
  return {
    expandedPaths: snapshot.expandedPaths.map((path) => rewritePathPrefix(path, oldPath, newPath)),
    selectedPath:
      snapshot.selectedPath === null ? null : rewritePathPrefix(snapshot.selectedPath, oldPath, newPath),
    scrollTop: snapshot.scrollTop,
  };
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function getLeafId(leaf: WorkspaceLeaf): string {
  return (leaf as unknown as InternalWorkspaceLeaf).id;
}
