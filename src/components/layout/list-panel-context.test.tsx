import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListPanelProvider } from "./list-panel-context";
import { useListPanel } from "./list-panel-context-internal";
import {
  TabsContext,
  type OpenTab,
  type TabsContextType,
} from "./tabs-context-internal";

const noop = () => {};

function tabsValue(tabs: OpenTab[], activeId: string): TabsContextType {
  return {
    tabs,
    activeId,
    closeTab: noop,
    newTab: noop,
    openInNewTab: noop,
    selectTab: noop,
    cycleTab: noop,
    reorderTabs: noop,
    goBack: noop,
    goForward: noop,
  };
}

function tab(id: string, href: string): OpenTab {
  return { id, history: [href], cursor: 0, title: id };
}

function PanelState() {
  const { collapsed, toggle } = useListPanel();
  return (
    <button type="button" onClick={toggle}>
      {collapsed ? "collapsed" : "open"}
    </button>
  );
}

function renderPanel(tabs: OpenTab[], activeId: string) {
  return render(
    <TabsContext.Provider value={tabsValue(tabs, activeId)}>
      <ListPanelProvider>
        <PanelState />
      </ListPanelProvider>
    </TabsContext.Provider>,
  );
}

describe("ListPanelProvider", () => {
  it("defaults database and record views open", () => {
    const databaseTab = tab("notebook", "/notebook");
    const view = renderPanel([databaseTab], databaseTab.id);

    expect(screen.getByRole("button")).toHaveTextContent("open");

    const recordTab = tab("notebook", "/notebook/example-note");
    view.rerender(
      <TabsContext.Provider value={tabsValue([recordTab], recordTab.id)}>
        <ListPanelProvider>
          <PanelState />
        </ListPanelProvider>
      </TabsContext.Provider>,
    );

    expect(screen.getByRole("button")).toHaveTextContent("open");
  });

  it("keeps manual overrides per tab", () => {
    const first = tab("first", "/resources");
    const second = tab("second", "/resources");
    const view = renderPanel([first, second], first.id);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("collapsed");

    view.rerender(
      <TabsContext.Provider value={tabsValue([first, second], second.id)}>
        <ListPanelProvider>
          <PanelState />
        </ListPanelProvider>
      </TabsContext.Provider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("open");

    view.rerender(
      <TabsContext.Provider value={tabsValue([first, second], first.id)}>
        <ListPanelProvider>
          <PanelState />
        </ListPanelProvider>
      </TabsContext.Provider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("collapsed");
  });

  it("resets a tab override after its view type changes", () => {
    const database = tab("one", "/notebook");
    const view = renderPanel([database], database.id);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("collapsed");

    const record = tab("one", "/notebook/example-note");
    view.rerender(
      <TabsContext.Provider value={tabsValue([record], record.id)}>
        <ListPanelProvider>
          <PanelState />
        </ListPanelProvider>
      </TabsContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("collapsed");

    view.rerender(
      <TabsContext.Provider value={tabsValue([database], database.id)}>
        <ListPanelProvider>
          <PanelState />
        </ListPanelProvider>
      </TabsContext.Provider>,
    );

    expect(screen.getByRole("button")).toHaveTextContent("open");
  });
});
