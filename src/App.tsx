import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import _ from 'lodash';
import moment from 'moment';
import useJira from './hooks/useJira';
import useLocalStorage from './hooks/useLocalStorage';
import Header from './components/Header';
import TimelineTable from './components/TimelineTable';
import SettingsModal from './components/SettingsModal';
import SearchModal from './components/SearchModal';
import ConfirmModal from './components/ConfirmModal';
import AddTimelogModal from './components/AddTimelogModal';
import EditTimelogModal from './components/EditTimelogModal';
import EditTrackingModal from './components/EditTrackingModal';
import EditActiveTrackingModal from './components/EditActiveTrackingModal';
import type { TimelineData } from './components/Timeline';
import type { JiraAccount, Settings, ProcessedTimelog, TrackedTicket, JiraTicket, State, JiraIssue, JiraWorklog } from './types/jira';
import { formatDuration } from './utils/time';
import { extractTextFromAtlassianDocumentFormat } from './utils/jira';
import useTheme from './hooks/useTheme';
import { randomUUID } from './utils/uuid';
import { JiraApiClient } from './services/jira';

// Makes sure global libraries are available for debugging if needed
declare global {
  interface Window {
    moment: typeof moment;
    _: typeof _;
    client: JiraApiClient | null;
    backendData: Array<{ issue: JiraIssue; worklog: JiraWorklog }> | undefined;
    clearState: () => void;
  }
}
window.moment = moment;
window._ = _;

const countWorkingDaysInMonth = (date: moment.Moment): number => {
  const cursor = date.clone().startOf('month');
  const end = date.clone().endOf('month');
  let count = 0;
  while (cursor.isSameOrBefore(end, 'day')) {
    if (cursor.isoWeekday() <= 5) {
      count += 1;
    }
    cursor.add(1, 'day');
  }
  return count;
};

const countWorkingDaysFromStartOfMonth = (date: moment.Moment): number => {
  const cursor = date.clone().startOf('month');
  const end = date.clone().startOf('day');
  let count = 0;
  while (cursor.isSameOrBefore(end, 'day')) {
    if (cursor.isoWeekday() <= 5) {
      count += 1;
    }
    cursor.add(1, 'day');
  }
  return count;
};

const countWorkingDaysFromDateToEndOfMonth = (date: moment.Moment): number => {
  const cursor = date.clone().startOf('day');
  const end = date.clone().endOf('month');
  let count = 0;
  while (cursor.isSameOrBefore(end, 'day')) {
    if (cursor.isoWeekday() <= 5) {
      count += 1;
    }
    cursor.add(1, 'day');
  }
  return count;
};

const getSecondsWithinRange = (logStart: moment.Moment, logEnd: moment.Moment, rangeStart: moment.Moment, rangeEnd: moment.Moment): number => {
  const effectiveStart = moment.max(logStart, rangeStart);
  const effectiveEnd = moment.min(logEnd, rangeEnd);

  if (!effectiveEnd.isAfter(effectiveStart)) {
    return 0;
  }

  return effectiveEnd.diff(effectiveStart, 'seconds');
};

export default function App() {
  type JiraLogEntry = { issue: JiraIssue; worklog: JiraWorklog };

  const [settings, setSettings] = useLocalStorage<Settings>('jiraTimelogSettings', {
    accounts: [],
    activeAccount: '',
    displayOnNewLine: false,
    isHeaderNonFloating: false,
    theme: 'system',
    plannedHours: 0,
  });

  const activeAccount = useMemo<JiraAccount | undefined>(
    () => settings.accounts.find((a) => a.id === settings.activeAccount),
    [settings.accounts, settings.activeAccount],
  );
  useTheme(settings.theme);
  const { client, state, backendData, fetchWorklogs, updateState } = useJira(activeAccount);

  const [selectedDate, setSelectedDate] = useState<Date>(moment().toDate());
  const [hoveredLogId, setHoveredLogId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(moment());

  // State for modals
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [isEditModalOpen, setEditModalOpen] = useState(false);
  const [isSearchModalOpen, setSearchModalOpen] = useState(false);
  const [isAddLogModalOpen, setAddLogModalOpen] = useState(false);
  const [isEditTrackingModalOpen, setEditTrackingModalOpen] = useState(false);
  const [isEditActiveTrackingModalOpen, setEditActiveTrackingModalOpen] = useState(false);
  const [confirmModalState, setConfirmModalState] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [editingLog, setEditingLog] = useState<ProcessedTimelog | null>(null);
  const [editingActiveLog, setEditingActiveLog] = useState<TrackedTicket | null>(null);
  const [ticketForAddLog, setTicketForAddLog] = useState<JiraTicket | null>(null);
  const [allAccountsDayLogs, setAllAccountsDayLogs] = useState<JiraLogEntry[]>([]);
  const [allAccountsMonthToDateLogs, setAllAccountsMonthToDateLogs] = useState<JiraLogEntry[]>([]);
  const [editingTrackingInfo, setEditingTrackingInfo] = useState<{
    id: string;
    key: string;
    summary: string;
    startTime: string;
    workDescription: string;
  } | null>(null);
  const multiAccountClientCache = useRef<Map<string, Promise<JiraApiClient>>>(new Map());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(moment());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleFetchWorklogs = useCallback(() => {
    if (client) {
      fetchWorklogs(selectedDate);
    }
  }, [client, fetchWorklogs, selectedDate]);

  useEffect(() => {
    handleFetchWorklogs();
  }, [handleFetchWorklogs]);

  const getClientForAccount = useCallback((account: JiraAccount) => {
    const cacheKey = `${account.id}:${account.email}:${account.jiraSubdomain}:${account.jiraToken}`;
    const cached = multiAccountClientCache.current.get(cacheKey);
    if (cached) return cached;

    const clientPromise = JiraApiClient.initialize({
      email: account.email,
      apiToken: account.jiraToken,
      jiraBaseUrl: account.jiraSubdomain,
    }).catch((error) => {
      multiAccountClientCache.current.delete(cacheKey);
      throw error;
    });

    multiAccountClientCache.current.set(cacheKey, clientPromise);
    return clientPromise;
  }, []);

  useEffect(() => {
    const accountsWithCredentials = settings.accounts.filter((account) => account.email && account.jiraToken && account.jiraSubdomain);
    if (accountsWithCredentials.length === 0) {
      setAllAccountsDayLogs([]);
      setAllAccountsMonthToDateLogs([]);
      return;
    }

    let isCancelled = false;
    const day = moment(selectedDate).format('YYYY-MM-DD');
    const startOfMonth = moment(selectedDate).startOf('month').format('YYYY-MM-DD');

    Promise.all(
      accountsWithCredentials.map(async (account) => {
        try {
          const accountClient = await getClientForAccount(account);
          const [dayLogs, monthToDateLogs] = await Promise.all([accountClient.getLogsForDay(day), accountClient.getLogsForRange(startOfMonth, day)]);
          return { dayLogs, monthToDateLogs };
        } catch (error) {
          console.error(`Failed to fetch aggregated logs for account '${account.jiraSubdomain}':`, error);
          return { dayLogs: [], monthToDateLogs: [] };
        }
      }),
    ).then((results) => {
      if (isCancelled) return;
      setAllAccountsDayLogs(results.flatMap((result) => result.dayLogs));
      setAllAccountsMonthToDateLogs(results.flatMap((result) => result.monthToDateLogs));
    });

    return () => {
      isCancelled = true;
    };
  }, [settings.accounts, selectedDate, getClientForAccount]);

  const timelineData = useMemo<TimelineData>(() => {
    const jiraTimelogs: JiraLogEntry[] = backendData || [];
    const logsWithDates: ProcessedTimelog[] = jiraTimelogs.map((log: JiraLogEntry) => {
      const start = moment(log.worklog.started);
      const end = moment(log.worklog.started).add(log.worklog.timeSpentSeconds, 'second');
      return {
        ...log,
        id: log.worklog.id,
        startDate: start.toDate(),
        startDateMoment: start,
        endDate: end.toDate(),
        endDateMoment: end,
        startDateString: `${start.format('YYYY-MM-DD HH:mm:ss')} (${formatDuration(start, currentTime)} ago)`,
        endDateString: `${end.format('YYYY-MM-DD HH:mm:ss')} (${formatDuration(end, currentTime)} ago)`,
        startDateDisplay: (
          <>
            {start.format('YYYY-MM-DD HH:mm:ss')} <br />{' '}
            <span className="text-xs text-gray-400 font-mono whitespace-pre">({formatDuration(start, currentTime)} ago)</span>
          </>
        ),
        endDateDisplay: (
          <>
            {end.format('YYYY-MM-DD HH:mm:ss')} <br />{' '}
            <span className="text-xs text-gray-400 font-mono whitespace-pre">({formatDuration(end, currentTime)} ago)</span>
          </>
        ),
        durationString: formatDuration(start, end),
        workDescription: extractTextFromAtlassianDocumentFormat(log.worklog.comment),
        isTracking: false,
      };
    });

    const trackedTickets: TrackedTicket[] = Object.entries(state.trackedTickets).map(([id, value]) => {
      const start = moment(value.startTime);
      return {
        id,
        issue: {
          key: value.key,
          self: value.self,
          fields: {
            summary: value.summary,
          },
        },
        startDate: start.toDate(),
        startDateMoment: start,
        startDateDisplay: (
          <>
            {start.format('YYYY-MM-DD HH:mm:ss')} <br />{' '}
            <span className="text-xs text-gray-400 font-mono whitespace-pre">({formatDuration(start, currentTime)} ago)</span>
          </>
        ),
        durationString: formatDuration(start, currentTime),
        workDescription: value.workDescription || '',
        isTracking: true,
      };
    });

    const allLogs = _.orderBy([...logsWithDates, ...trackedTickets], (log) => log.startDateMoment.valueOf(), 'asc');

    if (allLogs.length === 0) {
      return {
        allLogs: [],
        groupedLogs: {},
        uniqueTickets: [],
        ticketColors: {},
        minDate: new Date(),
        maxDate: new Date(),
        maxDateMinDateDuration: 0,
        xAxisTicks: [],
        displayMode: 'grouped',
      };
    }

    const minDate = moment(selectedDate).startOf('day').toDate();
    const maxDate = moment(selectedDate).endOf('day').toDate();
    const maxDateMinDateDuration = maxDate.getTime() - minDate.getTime();
    const tickCount = 5;
    const xAxisTicks = Array.from({ length: tickCount + 1 }, (_, i) => new Date(minDate.getTime() + (maxDateMinDateDuration / tickCount) * i));
    const colors = ['#008FFB']; // , '#00E396', '#FEB019', '#FF4560', '#775DD0'];
    const issueKeys = _.uniq(allLogs.map((log) => log.issue.key));

    const ticketColors = issueKeys.reduce(
      (acc, key, index) => {
        acc[key] = colors[index % colors.length];
        return acc;
      },
      {} as Record<string, string>,
    );

    if (settings.displayOnNewLine) {
      return {
        allLogs,
        groupedLogs: {},
        uniqueTickets: allLogs.filter((log) => !log.isTracking).map((log) => log.id),
        ticketColors,
        minDate,
        maxDate,
        maxDateMinDateDuration,
        xAxisTicks,
        displayMode: 'individual',
      };
    }
    const groupedLogs = _.groupBy(logsWithDates, (log) => log.issue.fields.project.key);
    const uniqueTickets = Object.keys(groupedLogs);
    return {
      allLogs,
      groupedLogs,
      uniqueTickets,
      ticketColors,
      minDate,
      maxDate,
      maxDateMinDateDuration,
      xAxisTicks,
      displayMode: 'grouped',
    };
  }, [backendData, selectedDate, settings.displayOnNewLine, currentTime, state.trackedTickets]);

  const totalTrackedTodayInSeconds = useMemo(() => {
    const startOfDay = moment(selectedDate).startOf('day');
    const endOfDay = moment(selectedDate).endOf('day');
    let totalSeconds = 0;

    allAccountsDayLogs.forEach((log) => {
      const logStart = moment(log.worklog.started);
      const logEnd = moment(log.worklog.started).add(log.worklog.timeSpentSeconds, 'second');
      totalSeconds += getSecondsWithinRange(logStart, logEnd, startOfDay, endOfDay);
    });

    Object.values(state.trackedTickets).forEach((tracked) => {
      const logStart = moment(tracked.startTime);
      totalSeconds += getSecondsWithinRange(logStart, currentTime, startOfDay, endOfDay);
    });

    return totalSeconds;
  }, [allAccountsDayLogs, selectedDate, currentTime, state.trackedTickets]);

  const workingDaysInSelectedMonth = useMemo(() => countWorkingDaysInMonth(moment(selectedDate)), [selectedDate]);
  const workingDaysElapsedInSelectedMonth = useMemo(() => countWorkingDaysFromStartOfMonth(moment(selectedDate)), [selectedDate]);
  const workingDaysRemainingInSelectedMonth = useMemo(() => countWorkingDaysFromDateToEndOfMonth(moment(selectedDate)), [selectedDate]);
  const isSelectedDateWeekend = useMemo(() => moment(selectedDate).isoWeekday() > 5, [selectedDate]);

  const actualMonthToDateSeconds = useMemo(() => {
    const startOfRange = moment(selectedDate).startOf('month');
    const endOfRange = moment(selectedDate).endOf('day');
    let totalSeconds = 0;

    allAccountsMonthToDateLogs.forEach((log) => {
      const logStart = moment(log.worklog.started);
      const logEnd = moment(log.worklog.started).add(log.worklog.timeSpentSeconds, 'second');
      totalSeconds += getSecondsWithinRange(logStart, logEnd, startOfRange, endOfRange);
    });

    Object.values(state.trackedTickets).forEach((tracked) => {
      const logStart = moment(tracked.startTime);
      totalSeconds += getSecondsWithinRange(logStart, currentTime, startOfRange, endOfRange);
    });

    return totalSeconds;
  }, [allAccountsMonthToDateLogs, selectedDate, currentTime, state.trackedTickets]);

  const actualMonthBeforeSelectedDateSeconds = useMemo(() => {
    const startOfRange = moment(selectedDate).startOf('month');
    const endOfRange = moment(selectedDate).startOf('day');
    let totalSeconds = 0;

    allAccountsMonthToDateLogs.forEach((log) => {
      const logStart = moment(log.worklog.started);
      const logEnd = moment(log.worklog.started).add(log.worklog.timeSpentSeconds, 'second');
      totalSeconds += getSecondsWithinRange(logStart, logEnd, startOfRange, endOfRange);
    });

    Object.values(state.trackedTickets).forEach((tracked) => {
      const logStart = moment(tracked.startTime);
      totalSeconds += getSecondsWithinRange(logStart, currentTime, startOfRange, endOfRange);
    });

    return totalSeconds;
  }, [allAccountsMonthToDateLogs, selectedDate, currentTime, state.trackedTickets]);

  const plannedMonthSeconds = useMemo(() => {
    if (!settings.plannedHours || settings.plannedHours <= 0) return null;
    return settings.plannedHours * 3600;
  }, [settings.plannedHours]);

  const plannedDailySeconds = useMemo(() => {
    if (!plannedMonthSeconds || plannedMonthSeconds <= 0) return null;
    if (isSelectedDateWeekend) return 0;
    if (workingDaysRemainingInSelectedMonth <= 0) return 0;

    const remainingSeconds = Math.max(plannedMonthSeconds - actualMonthBeforeSelectedDateSeconds, 0);
    return remainingSeconds / workingDaysRemainingInSelectedMonth;
  }, [plannedMonthSeconds, actualMonthBeforeSelectedDateSeconds, workingDaysRemainingInSelectedMonth, isSelectedDateWeekend]);

  const plannedMonthToDateSeconds = useMemo(() => {
    if (!plannedMonthSeconds || plannedMonthSeconds <= 0) return null;
    if (workingDaysInSelectedMonth <= 0) return null;
    if (workingDaysElapsedInSelectedMonth <= 0) return null;

    return (plannedMonthSeconds * workingDaysElapsedInSelectedMonth) / workingDaysInSelectedMonth;
  }, [plannedMonthSeconds, workingDaysInSelectedMonth, workingDaysElapsedInSelectedMonth]);

  const handleRowClick = useCallback((log: ProcessedTimelog) => {
    setEditingLog(log);
    setEditModalOpen(true);
  }, []);

  const handleAddLog = useCallback((ticket: JiraTicket) => {
    setTicketForAddLog(ticket);
    setSearchModalOpen(false);
    setAddLogModalOpen(true);
  }, []);

  const handleStartTracking = useCallback(
    (ticket: JiraTicket) => {
      updateState((currentState) => {
        const newTrackingId = randomUUID();
        const newTrackedTickets = {
          ...currentState.trackedTickets,
          [newTrackingId]: {
            key: ticket.key,
            startTime: moment().toISOString(),
            summary: ticket.summary,
            self: ticket.self,
            workDescription: '',
          },
        };
        return { ...currentState, trackedTickets: newTrackedTickets };
      });
    },
    [updateState],
  );

  const handleDiscardTracking = useCallback(
    (trackingId: string) => {
      setConfirmModalState({
        isOpen: true,
        title: 'Discard Tracking',
        message: 'Are you sure you want to discard this tracked time? It will be permanently lost.',
        onConfirm: () => {
          updateState((currentState) => {
            const newTrackedTickets = { ...currentState.trackedTickets };
            delete newTrackedTickets[trackingId];
            return { ...currentState, trackedTickets: newTrackedTickets };
          });
          setEditTrackingModalOpen(false);
        },
      });
    },
    [updateState],
  );

  const handleStopTracking = useCallback(
    (trackingId: string) => {
      if (!client || !state.trackedTickets[trackingId]) return;

      const trackingInfo = state.trackedTickets[trackingId];
      setEditingTrackingInfo({
        id: trackingId,
        key: trackingInfo.key,
        summary: trackingInfo.summary,
        startTime: trackingInfo.startTime,
        workDescription: trackingInfo.workDescription || '',
      });
      setEditTrackingModalOpen(true);
    },
    [client, state.trackedTickets],
  );

  const handleEditActiveTracking = useCallback((log: TrackedTicket) => {
    setEditingActiveLog(log);
    setEditActiveTrackingModalOpen(true);
  }, []);

  const handleSaveActiveTracking = useCallback(
    (id: string, updates: { startTime: string; workDescription: string }) => {
      updateState((currentState: State) => {
        const ticketToUpdate = currentState.trackedTickets[id];
        if (!ticketToUpdate) return currentState;

        const updatedTicket = {
          ...ticketToUpdate,
          startTime: moment(updates.startTime, 'YYYY-MM-DD HH:mm:ss').toISOString(),
          workDescription: updates.workDescription,
        };

        return {
          ...currentState,
          trackedTickets: {
            ...currentState.trackedTickets,
            [id]: updatedTicket,
          },
        };
      });
      setEditActiveTrackingModalOpen(false);
    },
    [updateState],
  );

  const handleDeleteLog = useCallback(
    (log: ProcessedTimelog) => {
      setConfirmModalState({
        isOpen: true,
        title: 'Delete Worklog',
        message: `Are you sure you want to delete this worklog for ${log.issue.key}? This action cannot be undone.`,
        onConfirm: async () => {
          if (!client) return;
          try {
            await client.deleteWorklog(log.issue.key, log.id);
            handleFetchWorklogs();
          } catch (error) {
            console.error('Failed to delete worklog:', error);
          }
        },
      });
    },
    [client, handleFetchWorklogs],
  );

  const toggleStar = useCallback(
    (key: string) => {
      updateState((currentState) => {
        const starredTickets = currentState.starredTickets.includes(key)
          ? currentState.starredTickets.filter((k) => k !== key)
          : [...currentState.starredTickets, key];
        return { ...currentState, starredTickets };
      });
    },
    [updateState],
  );

  return (
    <>
      <style>{` .timeline-grid { background-size: 20% 100%; background-image: linear-gradient(to right, #e5e7eb 1px, transparent 1px); } .dark .timeline-grid { background-image: linear-gradient(to right, #4b5563 1px, transparent 1px); } .timeline-bar { transition: all 0.2s ease-in-out; overflow: visible; } .timeline-bar:hover { z-index: 10; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); } .timeline-tooltip { visibility: hidden; opacity: 0; transition: opacity 0.2s; } .timeline-bar:hover .timeline-tooltip { visibility: visible; opacity: 1; } `}</style>

      <ConfirmModal
        isOpen={confirmModalState.isOpen}
        onClose={() => setConfirmModalState({ ...confirmModalState, isOpen: false })}
        title={confirmModalState.title}
        message={confirmModalState.message}
        onConfirm={confirmModalState.onConfirm}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        activeAccount={activeAccount}
      />
      <SearchModal
        isOpen={isSearchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        onAddLog={handleAddLog}
        onStartTracking={handleStartTracking}
        client={client}
        starredTickets={state.starredTickets}
        toggleStar={toggleStar}
      />
      <AddTimelogModal
        isOpen={isAddLogModalOpen}
        onClose={() => setAddLogModalOpen(false)}
        ticket={ticketForAddLog}
        client={client}
        onUpdate={handleFetchWorklogs}
      />
      <EditTimelogModal
        isOpen={isEditModalOpen}
        onClose={() => setEditModalOpen(false)}
        log={editingLog}
        client={client}
        onUpdate={handleFetchWorklogs}
        onDeleteRequest={handleDeleteLog}
      />
      <EditTrackingModal
        isOpen={isEditTrackingModalOpen}
        onClose={() => setEditTrackingModalOpen(false)}
        trackingInfo={editingTrackingInfo}
        client={client}
        onUpdate={() => {
          if (editingTrackingInfo) {
            updateState((currentState) => {
              const newTrackedTickets = { ...currentState.trackedTickets };
              delete newTrackedTickets[editingTrackingInfo.id];
              return { ...currentState, trackedTickets: newTrackedTickets };
            });
          }
          handleFetchWorklogs();
        }}
        onDiscard={handleDiscardTracking}
      />
      <EditActiveTrackingModal
        isOpen={isEditActiveTrackingModalOpen}
        onClose={() => setEditActiveTrackingModalOpen(false)}
        log={editingActiveLog}
        onSave={handleSaveActiveTracking}
      />

      <div>
        <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-w-[1024px]">
          <div className="p-4 sm:p-6 lg:p-8">
            <div className={`max-w-7xl mx-auto z-10 ${settings.isHeaderNonFloating ? '' : 'sticky top-4'}`}>
              <Header
                totalTrackedTodayInSeconds={totalTrackedTodayInSeconds}
                plannedDailySeconds={plannedDailySeconds}
                plannedMonthToDateSeconds={plannedMonthToDateSeconds}
                actualMonthToDateSeconds={actualMonthToDateSeconds}
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                setSearchModalOpen={setSearchModalOpen}
                setSettingsOpen={setSettingsOpen}
                timelineData={timelineData}
                hoveredLogId={hoveredLogId}
                setHoveredLogId={setHoveredLogId}
                handleRowClick={handleRowClick}
                activeAccount={activeAccount}
              />
            </div>

            {timelineData.allLogs.length > 0 && (
              <TimelineTable
                logs={timelineData.allLogs}
                hoveredLogId={hoveredLogId}
                setHoveredLogId={setHoveredLogId}
                onRowClick={handleRowClick}
                onEditTracking={handleEditActiveTracking}
                onStopTracking={handleStopTracking}
                onDiscardTracking={handleDiscardTracking}
                onStartTracking={handleStartTracking}
                onAddLog={handleAddLog}
                onDeleteLog={handleDeleteLog}
                starredTickets={state.starredTickets}
                toggleStar={toggleStar}
              />
            )}

            <footer className="text-center py-8 pb-0 text-gray-500 dark:text-gray-400">
              <small>
                Made with
                <span className="mx-1 text-red-500" role="img" aria-label="love">
                  ❤
                </span>
                by yrambler2001
                <br />
                Copyright © 2001-2025 - All Rights Reserved
              </small>
            </footer>
          </div>
        </div>
      </div>
    </>
  );
}
