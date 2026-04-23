"use client";

import { useEffect, useState } from "react";

const DESKTOP_ENTER_TO_SEND_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

export const useDesktopEnterToSend = (): boolean => {
  const [shouldSubmitOnEnter, setShouldSubmitOnEnter] = useState<boolean>(false);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(DESKTOP_ENTER_TO_SEND_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent): void => {
      setShouldSubmitOnEnter(event.matches);
    };

    setShouldSubmitOnEnter(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);

    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, []);

  return shouldSubmitOnEnter;
};
