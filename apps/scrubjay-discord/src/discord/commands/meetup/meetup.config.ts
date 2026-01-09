export function meetupConfig() {
  return {
    meetupChannelId: process.env.MEETUP_CHANNEL_ID!,
    boardChannelId: process.env.MEETUP_BOARD_CHANNEL_ID!,
  };
}
