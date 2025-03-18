/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

const DARK_SCHEME = {
  text: '#ECEDEE',
  background: '#003366',
  secondary: '#FF9966',
  tint: tintColorDark,
  icon: '#9BA1A6',
  tabIconDefault: '#9BA1A6',
  tabIconSelected: tintColorDark,
};

const LIGHT_SCHEME = {
  text: '#11181C',
  background: '#fff',
  tint: tintColorLight,
  icon: '#687076',
  tabIconDefault: '#687076',
  tabIconSelected: tintColorLight,
}

export const Colors = {
  light: DARK_SCHEME,
  dark: DARK_SCHEME,
};

export const DEFAULT_COLOR_SCHEME = 'dark';
