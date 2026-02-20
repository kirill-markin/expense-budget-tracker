"use client";

import { useState } from "react";

import type { MaskLevel } from "@/lib/dataMask";

export type DataMaskState = Readonly<{
  maskLevel: MaskLevel;
  setMaskLevel: (level: MaskLevel) => void;
}>;

export const useDataMask = (): DataMaskState => {
  const [maskLevel, setMaskLevel] = useState<MaskLevel>("hidden");
  return { maskLevel, setMaskLevel };
};
