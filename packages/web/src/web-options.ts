import type { ComponentType } from "react";
import type { ApiHelpers } from "./api.js";

export interface SignInProps {
  returnTo: string;
}

export interface AppUser {
  id: string;
  email: string;
  name?: string | null;
}

export interface SettingsScreenProps {
  user: AppUser;
  workspaceId: string;
  role: string;
  api: ApiHelpers;
}

export interface HeaderSlotProps extends SettingsScreenProps {
  onWorkspaceChange: () => void;
}

export interface SettingsScreen {
  id: string;
  label: string;
  component: ComponentType<SettingsScreenProps>;
}

export type BuiltInScreenId =
  "notifications" | "projects" | "tokens" | "account" | "model-keys" | "data";

export interface MountAppOptions {
  signIn?: ComponentType<SignInProps>;
  onSignOut?: () => void | Promise<void>;
  extraSettingsScreens?: readonly SettingsScreen[];
  headerStart?: ComponentType<HeaderSlotProps>;
  headerEnd?: ComponentType<HeaderSlotProps>;
  hideScreens?: readonly BuiltInScreenId[];
}

export interface MountedApp {
  onWorkspaceChange: () => void;
  unmount: () => void;
}
