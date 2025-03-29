import { Image, StyleSheet, Platform } from 'react-native';

import { HelloWave } from '@/components/HelloWave';
import ParallaxScrollView from '@/components/ParallaxScrollView';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { ExternalLink } from '@/components/ExternalLink';
import { Colors } from '@/constants/Colors';

// whoa

export default function HomeScreen() {
  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: Colors.dark.secondary, dark: Colors.dark.secondary }}
      headerImage={<Image
        source={require('@/assets/images/chaine-logo.png')}
        style={{ }}
      />}>
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">Slide in, the dance floor's open!</ThemedText>
        <HelloWave />
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">This is Chaîné</ThemedText>
        <ThemedText>
          The superapp made to unleash the inner dancer that lives within us all. Deep down, everyone is a dancer.
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Chaîné enables you to discover dance events and venues</ThemedText>
        <ThemedText>
          Use Chaîné to find past and upcoming classes and social dances near you, whether that's where you live or when you travel somewhere new
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Chaîné improves your dance skills</ThemedText>
        <ThemedText>
          From a community-curated move and technique catalogue, to AI assisted feedback, to booking instructor time and studio space, Chaîné can be your partner in leveling up or trying something new
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Chaîné connects you to the broader dance community</ThemedText>
        <ThemedText>
          Forgot the name of the person you shared your favorite dance of the night with?
          Connect to others in your class or at the social or competition you attended, search for compatible dance partners and local instructors
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Chaîné supercharges dance entrepreneurs</ThemedText>
        <ThemedText>
          Whether you're teaching dance, creating entertainment or educational content, organizing an event, running a studio, or DJ'ing for the night, Chaîné helps you at every step of the way, from payments, to marketing, to standing up a web presence, to scouting an ideal time and place.
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Chaîné &gt; Shazam</ThemedText>
        <ThemedText>
          Get instant access to the set list played at every class, social, or comp. See the most popular songs per dance per DJ per event, per bmp range. Let DJs know how you liked their set by sending a tip!
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Video privacy and attribution</ThemedText>
        <ThemedText>
          Class recaps are only visible to those who took the class. All videos properly attribute the dancers, venues, and DJs/musicians. With enough resources, Chaîné will go after the social media posters who profit off of stolen content.
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Your Competition Buddy</ThemedText>
        <ThemedText>
          Use Chaîné to track your competitor stats real-time, register for upcoming competitions, and access discounts for local businesses made available to competitors.
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Join the Conversation</ThemedText>
        <ThemedText>
          Join the Chaîné Discord&nbsp;
          <ThemedText lightColor='#5555FF' darkColor='#5555FF'>
            <ExternalLink href="https://discord.gg/rNxafvZUCx">
              https://discord.gg/rNxafvZUCx
            </ExternalLink>
          </ThemedText>
          &nbsp;to suggest/discuss features and improvements
        </ThemedText>
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepContainer: {
    gap: 8,
    marginBottom: 8,
  },
  reactLogo: {
    height: 178,
    width: 290,
    bottom: 0,
    left: 0,
    position: 'absolute',
  },
});
