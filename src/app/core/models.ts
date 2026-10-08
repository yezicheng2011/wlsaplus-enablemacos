export type ThemeMode = 'system' | 'light' | 'dark';
export type AppColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'rose';
export type DesktopCardType = 'current-class' | 'next-class' | 'today' | 'todo';

export interface PowerSchoolCredentials {
  schoolUrl: string;
  username: string;
  password: string;
}

export interface Course {
  id: string;
  name: string;
  sectionNumber: string;
  teacher: string;
  room: string;
  meetingPattern: string;
}

export interface ClassSession {
  id: string;
  courseId: string | null;
  courseName: string;
  teacher: string;
  room: string;
  startsAt: string;
  endsAt: string;
}

/** In-app notice served at https://wlsaplus.spacehubxyz.hk/notice.json. */
export interface AppNotice {
  id: string;
  title: string;
  content: string;
  type?: 'info' | 'success' | 'warning';
}

/** Minimal session fields the main process needs to schedule a class reminder. */
export type ClassReminderSession = Pick<ClassSession, 'id' | 'startsAt' | 'courseName' | 'room' | 'teacher'>;

export interface ClassReminderSyncPayload {
  enabled: boolean;
  sessions: ClassReminderSession[];
  /** One-time migration of the dedupe keys the old renderer timer kept in localStorage. */
  legacyNotified?: string[];
}

export interface ScheduleSnapshot {
  syncedAt: string;
  weekStart: string;
  weekEnd: string;
  sessions: ClassSession[];
  courses: Course[];
}

export type AttendanceKind = 'absence' | 'tardy' | 'other';

export interface AssignmentScore {
  id: string;
  name: string;
  description: string;
  dueDate: string | null;
  category: string;
  pointsEarned: number | null;
  pointsPossible: number | null;
  percent: number | null;
  letterGrade: string;
  isLate: boolean;
  isMissing: boolean;
  isAbsent: boolean;
  isExempt: boolean;
  isIncomplete: boolean;
  countsInFinalGrade: boolean;
}

export interface CourseProgressDetails {
  description: string;
  teacherComment: string;
  assignments: AssignmentScore[];
  loadedAt: string;
}

export interface ProgressCourse {
  id: string;
  name: string;
  teacher: string;
  room: string;
  meetingPattern: string;
  term: string;
  grade: string;
  absences: number | null;
  tardies: number | null;
  detailsPath: string;
  details: CourseProgressDetails | null;
}

export interface AttendanceEvent {
  id: string;
  date: string;
  courseName: string;
  meetingPattern: string;
  kind: AttendanceKind;
  label: string;
  count: number;
}

export interface ProgressSnapshot {
  syncedAt: string;
  term: string;
  absenceTotal: number | null;
  tardyTotal: number | null;
  attendanceStart: string;
  attendanceEnd: string;
  courses: ProgressCourse[];
  attendanceEvents: AttendanceEvent[];
}

export const TODO_COLOR_OPTIONS = [
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
] as const;

export type TodoColor = typeof TODO_COLOR_OPTIONS[number]['value'];

export const TODO_ICON_OPTIONS = [
  { value: 'assignment', label: 'Assignment' },
  { value: 'menu_book', label: 'Study' },
  { value: 'draw', label: 'Writing' },
  { value: 'science', label: 'Lab' },
  { value: 'groups', label: 'Group work' },
  { value: 'event', label: 'Event' },
  { value: 'laptop', label: 'Online' },
  { value: 'flag', label: 'Important' },
] as const;

export type TodoIcon = typeof TODO_ICON_OPTIONS[number]['value'];
export type TodoTimeType = 'time' | 'deadline';

export interface TodoItem {
  id: string;
  title: string;
  details: string;
  createdAt: string;
  endAt: string | null;
  color: TodoColor | null;
  icon: TodoIcon | null;
  timeType: TodoTimeType;
}

const TODO_COLORS = new Set<TodoColor>(TODO_COLOR_OPTIONS.map((option) => option.value));
const TODO_ICONS = new Set<TodoIcon>(TODO_ICON_OPTIONS.map((option) => option.value));

export function normalizeTodoColor(value: unknown): TodoColor | null {
  return typeof value === 'string' && TODO_COLORS.has(value as TodoColor) ? value as TodoColor : null;
}

export function normalizeTodoIcon(value: unknown): TodoIcon | null {
  return typeof value === 'string' && TODO_ICONS.has(value as TodoIcon) ? value as TodoIcon : null;
}

export function normalizeTodoTimeType(value: unknown, fallback: TodoTimeType = 'time'): TodoTimeType {
  return value === 'time' || value === 'deadline' ? value : fallback;
}

export function normalizeTodoEndAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function todoDeadlineProgress(todo: Pick<TodoItem, 'createdAt' | 'endAt'>, now = Date.now()): number {
  if (!todo.endAt) return 0;
  const start = Date.parse(todo.createdAt);
  const end = Date.parse(todo.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end <= start) return now >= end ? 100 : 0;
  return Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
}

export interface AppSettings {
  theme: ThemeMode;
  color: AppColor;
  tuningEnabled: boolean;
  tunedTime: string | null;
  /** macOS desktop: notify a few minutes before each class starts. */
  classRemindersEnabled: boolean;
}

export interface PlatformInfo {
  kind: 'electron';
  os: 'macos';
  supportsPowerSchool: boolean;
  supportsDesktopCards: boolean;
  supportsVpn: boolean;
  supportsScreenTranslation: boolean;
  supportsPhoneControl: boolean;
}


export type VpnConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'delegated' | 'error' | 'unavailable';
export type VpnConnectionMode = 'full-tunnel';

export interface WeChatProbeResult {
  reachable: boolean;
  latencyMs: number | null;
  viaVpn: boolean;
  url: string;
  status: number;
  message: string;
}

export interface VpnNode {
  id: string;
  name: string;
  type: string;
  server?: string;
  port?: number;
  latencyMs?: number | null;
}

export interface VpnStatus {
  state: VpnConnectionState;
  message: string;
  connectedAt: string | null;
  mode: VpnConnectionMode | 'external-client' | 'unavailable';
  sourceId?: string;
  nodeName?: string;
  requiresElevation?: boolean;
}

export type UpdateState = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  message: string;
  currentVersion: string;
  version: string | null;
  percent: number | null;
}

export interface TranslationResult {
  text: string;
  detectedLanguage: string;
}

export interface PlatformHttpResponse {
  status: number;
  url: string;
  text: string;
}

export interface DesktopCardInfo {
  id: number;
  type: DesktopCardType;
}

export interface DesktopCardSettings {
  launchAtStartup: boolean;
}
