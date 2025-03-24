// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const DELIMITER = "-";

/**
 * 문자열 입력을 기반으로 해시 코드를 생성합니다.
 * @param input 변환할 문자열
 * @returns 해시 코드
 */
function getHashCode(input: string): number {
  let hash: number = 0;

  if (input.length === 0) {
    return hash;
  }

  for (let i = 0; i < input.length; i++) {
    const chr = input.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
  }

  return hash;
}

/**
 * 특정 클라이언트가 롤아웃 대상인지 결정합니다.
 * @param clientId 클라이언트 ID
 * @param rollout 롤아웃 비율
 * @param releaseTag 릴리스 태그
 * @returns 롤아웃 선택 여부
 */
export function isSelectedForRollout(clientId: string, rollout: number, releaseTag: string): boolean {
  // 클라이언트 ID와 릴리즈 태그를 결합해 고유 식별자를 생성합니다.
  const identifier: string = clientId + DELIMITER + releaseTag;
  // 해당 식별자의 해시 코드를 계산합니다.
  const hashValue: number = getHashCode(identifier);
  // 해시 코드를 100으로 나눈 나머지를 계산합니다.
  // 이 값이 롤아웃 비율보다 작으면 롤아웃 대상입니다.
  return Math.abs(hashValue) % 100 < rollout;
}

/**
 * 롤아웃이 완료되지 않았는지(100% 미만인지) 확인합니다.
 * @param rollout 롤아웃 비율
 * @returns 롤아웃 비율이 100% 미만인지 여부
 */
export function isUnfinishedRollout(rollout: number): boolean {
  return rollout && rollout !== 100; // 롤아웃이 100%인 경우는 사실상 모든 사용자에게 배포된 것이므로 일반 업데이트로 취급합니다.
}
